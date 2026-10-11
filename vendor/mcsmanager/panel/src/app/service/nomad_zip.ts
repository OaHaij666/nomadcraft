import fs from "fs";
import * as yauzl from "yauzl";
// Native range streams avoid the bundled fd-slicer's backpressure stall on large entries.
class NativeZipReader extends yauzl.RandomAccessReader {
  constructor(private file: string) { super(); }
  _readStreamForRange(start: number, end: number) { return fs.createReadStream(this.file, {start, end: end - 1}); }
}
export function openNomadZip(file: string, options: yauzl.Options, callback: (error: Error | null, zip: yauzl.ZipFile) => void) {
  fs.stat(file, (error, stat) => {
    if (error) { callback(error, undefined as any); return; }
    yauzl.fromRandomAccessReader(new NativeZipReader(file), stat.size, options, callback);
  });
}
