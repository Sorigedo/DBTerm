use crate::io::ProtocolEncode;
pub struct CancelRequest { pub process_id:u32,pub secret_key:u32 }
impl ProtocolEncode<'_> for CancelRequest {
    fn encode_with(&self,buf:&mut Vec<u8>,_:())->Result<(),crate::Error>{
        buf.extend_from_slice(&16u32.to_be_bytes());
        buf.extend_from_slice(&80877102u32.to_be_bytes());
        buf.extend_from_slice(&self.process_id.to_be_bytes());
        buf.extend_from_slice(&self.secret_key.to_be_bytes());
        Ok(())
    }
}
#[test]
fn cancel_request_wire_packet_has_exact_length_code_and_identity(){
    let mut bytes=Vec::new();CancelRequest{process_id:0x01020304,secret_key:0xf1f2f3f4}.encode(&mut bytes).unwrap();
    assert_eq!(bytes,vec![0,0,0,16,4,210,22,46,1,2,3,4,241,242,243,244]);
}
