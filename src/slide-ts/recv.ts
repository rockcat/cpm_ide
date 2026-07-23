import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CTRL_ACK,
  CTRL_FIN,
  CTRL_NAK,
  CTRL_RDY,
  openSerial,
  SerialSession,
  WIN_SIZE,
  sleep
} from "./protocol.js";

type RecvResult =
  | { kind: "ok"; bytes: number }
  | { kind: "fin" }
  | { kind: "cancelled" }
  | { kind: "error" };

export async function recvSession(
  portName: string,
  baud: number,
  outputDir: string,
  debug: boolean
): Promise<void> {
  console.log("SLIDE v0.2 - Serial Line Inter-Device Exchange");
  console.log(`  Port:   ${portName} @ ${baud} baud`);
  console.log("  Mode:   receive");
  console.log(`  Output: ${outputDir}`);
  console.log("");

  await fs.mkdir(outputDir, { recursive: true });
  const session = await openSerial(portName, baud);

  try {
    await handshakeAsReceiver(session, debug);

    let fileCount = 0;
    let totalBytes = 0;
    const start = Date.now();

    while (true) {
      console.log(`\n-- Waiting for file ${fileCount + 1}... --`);
      const result = await recvOneFile(session, outputDir, debug);

      if (result.kind === "ok") {
        fileCount += 1;
        totalBytes += result.bytes;
        continue;
      }
      if (result.kind === "fin") {
        await session.sendControl(CTRL_FIN);
        if (debug) {
          console.error("DEBUG sent FIN echo");
        }
        break;
      }
      if (result.kind === "cancelled") {
        console.log("Cancelled by Z80.");
        break;
      }

      console.log("File transfer failed, aborting session.");
      break;
    }

    const elapsed = (Date.now() - start) / 1000;
    console.log("");
    console.log(`OK ${fileCount} file(s) received, ${totalBytes} bytes in ${elapsed.toFixed(1)}s`);
  } finally {
    await session.close();
  }
}

async function handshakeAsReceiver(session: SerialSession, debug: boolean): Promise<void> {
  process.stdout.write("Waiting for Z80 sender (start SLIDE S <file> on Z80 now)... ");

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const ctrl = await session.recvControl(2000);
      if (ctrl.kind === "rdy") {
        await session.sendControl(CTRL_RDY);
        console.log("connected");
        await sleep(50);
        await session.clearInput();
        return;
      }
      if (ctrl.kind === "can") {
        console.log("cancelled by Z80");
        throw new Error("Session cancelled by peer");
      }
      if (debug) {
        console.error(`DEBUG handshake got ${ctrl.kind}`);
      }
    } catch {
      // keep waiting
    }
  }

  throw new Error("Timeout waiting for Z80 ready signal");
}

async function recvOneFile(
  session: SerialSession,
  outputDir: string,
  debug: boolean
): Promise<RecvResult> {
  let filename: string;
  let filesize: number;

  try {
    const frame = await session.recvFrame(30000);
    if (frame.kind === "fin") {
      return { kind: "fin" };
    }
    if (frame.kind === "cancel") {
      return { kind: "cancelled" };
    }

    if (debug) {
      console.error(`DEBUG header seq=${frame.seq} len=${frame.payload.length}`);
    }

    const parsed = parseHeader(frame.payload);
    filename = parsed.filename;
    filesize = parsed.filesize;
  } catch {
    return { kind: "error" };
  }

  const filepath = path.join(outputDir, filename);
  console.log(`  ${filename} - ${filesize} bytes`);

  await session.sendControl(CTRL_ACK, 0);

  let expectedSeq = 1;
  const receivedData: number[] = [];
  let retries = 0;
  const maxRetries = 15;

  while (true) {
    try {
      const frame = await session.recvFrame(10000);

      if (frame.kind === "fin") {
        return { kind: "error" };
      }
      if (frame.kind === "cancel") {
        return { kind: "cancelled" };
      }

      retries = 0;

      if (frame.payload.length === 0) {
        await session.sendControl(CTRL_ACK, expectedSeq & 0xff);
        break;
      }

      if (frame.seq !== (expectedSeq & 0xff)) {
        if (debug) {
          console.error(`DEBUG seq mismatch got=${frame.seq} expected=${expectedSeq & 0xff}`);
        }
        await session.sendControl(CTRL_NAK, expectedSeq & 0xff);
        continue;
      }

      for (const b of frame.payload) {
        receivedData.push(b);
      }

      expectedSeq = (expectedSeq + 1) & 0xff;

      if (((expectedSeq - 1) & (WIN_SIZE - 1)) === 0) {
        await session.sendControl(CTRL_ACK, frame.seq);
      }

      if (debug) {
        const shown = Math.min(receivedData.length, filesize);
        console.error(`DEBUG frame seq=${frame.seq} len=${frame.payload.length} total=${shown}`);
      }
    } catch {
      retries += 1;
      if (retries >= maxRetries) {
        return { kind: "error" };
      }
      await session.sendControl(CTRL_NAK, expectedSeq & 0xff);
    }
  }

  const out = Buffer.from(receivedData.slice(0, filesize));
  await fs.writeFile(filepath, out);
  console.log(`  saved ${filepath}`);

  return { kind: "ok", bytes: filesize };
}

function parseHeader(payload: Buffer): { filename: string; filesize: number } {
  const nullIdx = payload.indexOf(0);
  if (nullIdx < 0) {
    throw new Error("No null terminator in header");
  }
  if (payload.length < nullIdx + 5) {
    throw new Error("Header too short for file size");
  }

  const filename = payload.subarray(0, nullIdx).toString("utf8");
  const filesize = payload.readUInt32LE(nullIdx + 1);
  return { filename, filesize };
}
