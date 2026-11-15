use std::{future::Future,time::Duration};
/// A CancelRequest is authenticated but unacknowledged. Never poll arbitrary work
/// again after cancellation: it may not have sent its SQL yet. Callers must close
/// the cancelled session, and this helper never claims confirmed server stopping.
pub(crate) async fn run<T>(operation:impl Future<Output=Result<T,String>>,receiver:tokio::sync::oneshot::Receiver<()>,token:sqlx::postgres::PgCancelToken)->(Result<T,String>,bool){
    run_with_cancel(operation,receiver,token.cancel_query()).await
}

async fn run_with_cancel<T,E>(operation:impl Future<Output=Result<T,String>>,receiver:tokio::sync::oneshot::Receiver<()>,cancel:impl Future<Output=Result<(),E>>)->(Result<T,String>,bool){
    let started=std::sync::atomic::AtomicBool::new(false);
    tokio::pin!(operation);
    let tracked=std::future::poll_fn(|cx|{started.store(true,std::sync::atomic::Ordering::Relaxed);operation.as_mut().poll(cx)});
    tokio::pin!(tracked);
    tokio::select!{biased;
        _=receiver=>{
            // A ready cancellation wins before the operation's first poll.
            // Draining here would start SQL only after its cancel was sent.
            if !started.load(std::sync::atomic::Ordering::Relaxed){return(Err("查询已取消；本次语句尚未开始执行".into()),true)}
            let sent=tokio::time::timeout(Duration::from_secs(3),cancel).await;
            if !matches!(sent,Ok(Ok(()))){return(Err("查询已取消等待；服务端取消信号发送未确认，请核查数据库和锁状态，勿重复写入".into()),true)}
            (Err("已发送查询取消请求；客户端已停止等待并废弃连接，服务端停止及写入结果未确认，请核查数据库和锁状态，勿重复写入".into()),true)
        }
        result=&mut tracked=>(result,false),
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    use std::sync::atomic::{AtomicUsize,Ordering};

    #[tokio::test]
    async fn presignalled_cancel_never_starts_operation(){
        let polls=AtomicUsize::new(0);
        let requests=AtomicUsize::new(0);
        let (sender,receiver)=tokio::sync::oneshot::channel();
        sender.send(()).unwrap();
        let operation=async{polls.fetch_add(1,Ordering::SeqCst);Ok::<_,String>(())};
        let cancel=async{requests.fetch_add(1,Ordering::SeqCst);Ok::<_,String>(())};
        let (result,cancelled)=run_with_cancel(operation,receiver,cancel).await;
        assert!(result.is_err());assert!(cancelled);
        assert_eq!(polls.load(Ordering::SeqCst),0,"SQL must not begin after cancellation already arrived");
        assert_eq!(requests.load(Ordering::SeqCst),0,"No server query exists to cancel");
    }

    #[tokio::test]
    async fn completed_operation_does_not_send_cancellation(){
        let requests=AtomicUsize::new(0);
        let (_sender,receiver)=tokio::sync::oneshot::channel();
        let cancel=async{requests.fetch_add(1,Ordering::SeqCst);Ok::<_,String>(())};
        let (result,cancelled)=run_with_cancel(async{Ok::<_,String>(42)},receiver,cancel).await;
        assert_eq!(result,Ok(42));assert!(!cancelled);assert_eq!(requests.load(Ordering::SeqCst),0);
    }

    #[tokio::test]
    async fn active_cancel_never_resumes_original_operation(){
        let (sender,receiver)=tokio::sync::oneshot::channel();
        let (stopped,stop)=tokio::sync::oneshot::channel();
        let finished=AtomicUsize::new(0);
        let operation=async{sender.send(()).unwrap();stop.await.unwrap();finished.fetch_add(1,Ordering::SeqCst);Err::<(),_>("server cancelled".into())};
        let cancel=async{stopped.send(()).unwrap();Ok::<_,String>(())};
        let (result,cancelled)=run_with_cancel(operation,receiver,cancel).await;
        assert!(cancelled);assert_eq!(finished.load(Ordering::SeqCst),0);assert!(result.unwrap_err().contains("服务端停止及写入结果未确认"));
    }

    #[tokio::test]
    async fn completion_racing_active_cancel_is_not_reported_as_safe_retry(){
        let (sender,receiver)=tokio::sync::oneshot::channel();
        let (finished,finish)=tokio::sync::oneshot::channel();
        let operation=async{sender.send(()).unwrap();finish.await.unwrap();Ok::<_,String>(())};
        let cancel=async{finished.send(()).unwrap();Ok::<_,String>(())};
        let (result,cancelled)=run_with_cancel(operation,receiver,cancel).await;
        assert!(cancelled);assert!(result.unwrap_err().contains("写入结果未确认"));
    }

    #[tokio::test]
    async fn failed_cancel_send_drops_operation_without_resuming_it(){
        let (sender,receiver)=tokio::sync::oneshot::channel();
        let resumed=AtomicUsize::new(0);
        let operation=async{sender.send(()).unwrap();std::future::pending::<()>().await;resumed.fetch_add(1,Ordering::SeqCst);Ok::<_,String>(())};
        let (result,cancelled)=run_with_cancel(operation,receiver,async{Err::<(),_>("network")}).await;
        assert!(cancelled);assert!(result.unwrap_err().contains("取消信号发送未确认"));assert_eq!(resumed.load(Ordering::SeqCst),0);
    }

    #[tokio::test]
    async fn yielded_before_sql_is_never_resumed_after_cancel(){
        let (sender,receiver)=tokio::sync::oneshot::channel();
        let (sent,signal)=tokio::sync::oneshot::channel();
        let writes=AtomicUsize::new(0);
        let operation=async{sender.send(()).unwrap();signal.await.unwrap();writes.fetch_add(1,Ordering::SeqCst);Ok::<_,String>(())};
        let cancel=async{sent.send(()).unwrap();Ok::<_,String>(())};
        let (result,cancelled)=run_with_cancel(operation,receiver,cancel).await;
        assert!(result.is_err());assert!(cancelled);
        assert_eq!(writes.load(Ordering::SeqCst),0,"A pending future must never resume into SQL after CancelRequest");
    }
}
