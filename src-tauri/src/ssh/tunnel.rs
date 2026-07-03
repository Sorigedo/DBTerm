// SSH 隧道：local（本地端口转发）与 dynamic（SOCKS5 动态转发）
// remote（远程转发）由 SshHandler::server_channel_open_forwarded_tcpip 回调处理

use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use russh::client;
use super::{SshHandler, SshTunnel};

type SharedHandle = Arc<client::Handle<SshHandler>>;

/// 本地端口转发：listen bind_ip:bind_port → 服务器侧 target_ip:target_port
pub async fn run_local_forward(handle: SharedHandle, t: SshTunnel) {
    // 只允许 loopback，防止将隧道暴露到局域网
    let bind = match t.bind_ip.as_str() {
        "" | "127.0.0.1" | "::1" | "localhost" => if t.bind_ip.is_empty() { "127.0.0.1" } else { t.bind_ip.as_str() },
        other => { log::warn!("隧道 {} bind_ip={other} 非 loopback，强制改为 127.0.0.1", t.name); "127.0.0.1" }
    };
    let listener = match TcpListener::bind((bind, t.bind_port)).await {
        Ok(l) => l,
        Err(e) => { log::warn!("隧道 {} 绑定 {bind}:{} 失败: {e}", t.name, t.bind_port); return }
    };
    log::info!("本地隧道 {} 监听 {bind}:{}", t.name, t.bind_port);
    loop {
        let Ok((mut tcp, peer)) = listener.accept().await else { break };
        let handle = handle.clone();
        let target_ip = t.target_ip.clone();
        let target_port = t.target_port;
        tokio::spawn(async move {
            match handle.channel_open_direct_tcpip(
                target_ip, target_port as u32,
                peer.ip().to_string(), peer.port() as u32,
            ).await {
                Ok(ch) => {
                    let mut stream = ch.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                }
                Err(e) => log::warn!("隧道通道打开失败: {e}"),
            }
        });
    }
}

/// 动态转发：本地起 SOCKS5 服务，所有连接经 SSH direct-tcpip 转发
pub async fn run_dynamic_forward(handle: SharedHandle, t: SshTunnel) {
    // SOCKS5 代理强制只监听 loopback，避免局域网任意主机使用此代理
    let bind = match t.bind_ip.as_str() {
        "" | "127.0.0.1" | "::1" | "localhost" => if t.bind_ip.is_empty() { "127.0.0.1" } else { t.bind_ip.as_str() },
        other => { log::warn!("SOCKS5 隧道 {} bind_ip={other} 非 loopback，强制改为 127.0.0.1", t.name); "127.0.0.1" }
    };
    let listener = match TcpListener::bind((bind, t.bind_port)).await {
        Ok(l) => l,
        Err(e) => { log::warn!("SOCKS5 隧道 {} 绑定 {bind}:{} 失败: {e}", t.name, t.bind_port); return }
    };
    log::info!("SOCKS5 动态隧道 {} 监听 {bind}:{}", t.name, t.bind_port);
    loop {
        let Ok((tcp, peer)) = listener.accept().await else { break };
        let handle = handle.clone();
        tokio::spawn(async move {
            if let Err(e) = serve_socks5(handle, tcp, peer.ip().to_string(), peer.port()).await {
                log::debug!("SOCKS5 会话结束: {e}");
            }
        });
    }
}

/// 最小 SOCKS5 实现（RFC1928）：无认证，仅 CONNECT
async fn serve_socks5(
    handle: SharedHandle,
    mut tcp: TcpStream,
    peer_ip: String,
    peer_port: u16,
) -> Result<(), String> {
    // 1. 方法协商
    let mut head = [0u8; 2];
    tcp.read_exact(&mut head).await.map_err(|e| e.to_string())?;
    if head[0] != 0x05 { return Err("非 SOCKS5 协议".into()); }
    let mut methods = vec![0u8; head[1] as usize];
    tcp.read_exact(&mut methods).await.map_err(|e| e.to_string())?;
    if !methods.contains(&0x00) {
        let _ = tcp.write_all(&[0x05, 0xFF]).await; // 无可接受的认证方式
        return Err("客户端不支持无认证模式".into());
    }
    tcp.write_all(&[0x05, 0x00]).await.map_err(|e| e.to_string())?; // NO AUTH

    // 2. 请求：VER CMD RSV ATYP
    let mut req = [0u8; 4];
    tcp.read_exact(&mut req).await.map_err(|e| e.to_string())?;
    if req[1] != 0x01 { // 仅支持 CONNECT
        let _ = tcp.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        return Err("不支持的 SOCKS 命令".into());
    }
    let host = match req[3] {
        0x01 => { // IPv4
            let mut b = [0u8; 4];
            tcp.read_exact(&mut b).await.map_err(|e| e.to_string())?;
            std::net::Ipv4Addr::from(b).to_string()
        }
        0x03 => { // 域名
            let mut len = [0u8; 1];
            tcp.read_exact(&mut len).await.map_err(|e| e.to_string())?;
            let mut name = vec![0u8; len[0] as usize];
            tcp.read_exact(&mut name).await.map_err(|e| e.to_string())?;
            String::from_utf8_lossy(&name).into_owned()
        }
        0x04 => { // IPv6
            let mut b = [0u8; 16];
            tcp.read_exact(&mut b).await.map_err(|e| e.to_string())?;
            std::net::Ipv6Addr::from(b).to_string()
        }
        _ => {
            let _ = tcp.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            return Err("不支持的地址类型".into());
        }
    };
    let mut pb = [0u8; 2];
    tcp.read_exact(&mut pb).await.map_err(|e| e.to_string())?;
    let port = u16::from_be_bytes(pb);

    // 3. 经 SSH 打开通道
    match handle.channel_open_direct_tcpip(host, port as u32, peer_ip, peer_port as u32).await {
        Ok(ch) => {
            tcp.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await
                .map_err(|e| e.to_string())?;
            let mut stream = ch.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
            Ok(())
        }
        Err(e) => {
            let _ = tcp.write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            Err(format!("SSH 通道打开失败: {e}"))
        }
    }
}
