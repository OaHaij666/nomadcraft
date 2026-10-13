//! JVM console encoding on Windows is not necessarily UTF-8. Never abandon the
//! readiness/checkpoint stream because one diagnostic line uses a native encoding.
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
pub(crate) async fn drain<R: AsyncRead + Unpin>(reader: R, mut consume: impl FnMut(String)) -> std::io::Result<()> {
    let mut lines = BufReader::new(reader).split(b'\n');
    while let Some(bytes) = lines.next_segment().await? {
        consume(String::from_utf8_lossy(&bytes).trim_end_matches('\r').to_owned());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn native_encoding_diagnostic_does_not_hide_readiness_or_save_confirmation() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, reader) = tokio::io::duplex(256);
        let input = b"\xB2\xE2\xCA\xD4 native console\r\nDone (1.2s)! For help, type help\r\nSaved the game\r\n";
        writer.write_all(input).await.unwrap();
        drop(writer);
        let mut lines = Vec::new();
        super::drain(reader, |line| lines.push(line)).await.unwrap();
        assert_eq!(lines.len(), 3);
        assert!(lines[1].contains("Done (") && lines[1].contains("For help"));
        assert_eq!(lines[2], "Saved the game");
        assert!(!lines[1].ends_with('\r'));
    }
}
