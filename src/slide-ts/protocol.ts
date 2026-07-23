import SerialPort from "serialport";
import type { SerialLink } from "../xmodem.js";

export const SOF = 0x01;
export const CTRL_ACK = 0x06;
export const CTRL_NAK = 0x15;
export const CTRL_RDY = 0x11;
export const CTRL_FIN = 0x04;
export const CTRL_CAN = 0x18;

export const WIN_SIZE = 4;
export const FRAME_SIZE = 1024;

export const WAKEUP_SIG = [0x1b, 0x5e, 0x53, 0x4c, 0x49, 0x44, 0x45];

export type Control =
  | { kind: "ack"; seq: number }
  | { kind: "nak"; seq: number }
  | { kind: "rdy" }
  | { kind: "fin" }
  | { kind: "can" };

export type FrameResult =
  | { kind: "data"; seq: number; payload: Buffer }
  | { kind: "fin" }
  | { kind: "cancel" };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function crc16Ccitt(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc;
}

export function buildFrame(seq: number, payload: Uint8Array): Buffer {
  const length = payload.length;
  const lenH = (length >> 8) & 0xff;
  const lenL = length & 0xff;

  const crcData = Buffer.alloc(3 + length);
  crcData[0] = seq & 0xff;
  crcData[1] = lenH;
  crcData[2] = lenL;
  Buffer.from(payload).copy(crcData, 3);
  const crc = crc16Ccitt(crcData);

  const frame = Buffer.alloc(1 + 1 + 2 + length + 2);
  let off = 0;
  frame[off++] = SOF;
  frame[off++] = seq & 0xff;
  frame[off++] = lenH;
  frame[off++] = lenL;
  Buffer.from(payload).copy(frame, off);
  off += length;
  frame[off++] = (crc >> 8) & 0xff;
  frame[off] = crc & 0xff;
  return frame;
}

export function buildHeaderFrame(filename: string, filesize: number): Buffer {
  const upper = filename
    .split(/[\\/]/)
    .pop()
    ?.toUpperCase() ?? filename.toUpperCase();
  const nameBytes = Buffer.from(upper, "utf8");
  const payload = Buffer.alloc(nameBytes.length + 1 + 4);
  nameBytes.copy(payload, 0);
  payload[nameBytes.length] = 0;
  payload.writeUInt32LE(filesize >>> 0, nameBytes.length + 1);
  return buildFrame(0, payload);
}

/**
 * Opens a dedicated port for standalone CLI use (`slide-ts send/recv`).
 * Not used by the VS Code extension, which already holds the port open for
 * the terminal and instead builds a SerialSession directly from its shared
 * SerialLink - a second, independently-opened SerialPort on the same path
 * would simply fail (or steal the port out from under the terminal).
 */
export async function openSerial(path: string, baud: number): Promise<SerialSession> {
  // Two-argument (path, options) form, matching the serialport@9 typings
  // this project is built against (the single options-object-with-path
  // form is a later serialport-major API).
  const port = new SerialPort(path, {
    baudRate: baud,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    rtscts: true,
    autoOpen: false
  } as any);

  await new Promise<void>((resolve, reject) => {
    port.open((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  const listeners = new Set<(data: Buffer) => void>();
  port.on("data", (chunk: Buffer) => {
    for (const listener of listeners) {
      listener(chunk);
    }
  });

  const link: SerialLink = {
    write: (data: Buffer) => {
      port.write(data);
    },
    onData: (listener: (data: Buffer) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    drain: () => new Promise<void>((resolve, reject) => {
      port.drain((err) => (err ? reject(err) : resolve()));
    }),
    flush: () => new Promise<void>((resolve, reject) => {
      port.flush((err) => (err ? reject(err) : resolve()));
    }),
    baudRate: () => port.baudRate
  };

  return new SerialSession(link, () => new Promise<void>((resolve) => {
    if (!port.isOpen) {
      resolve();
      return;
    }
    port.close(() => resolve());
  }));
}

export class SerialSession {
  private readonly link: SerialLink;

  private readonly subscription: { dispose(): void };

  private readonly ownedPortCloser?: () => Promise<void>;

  private readonly queue: number[] = [];

  private readonly waiters: Array<(value: number | undefined) => void> = [];

  /**
   * `ownedPortCloser` is only supplied by openSerial() (the standalone CLI
   * path), which opened its own dedicated port and is responsible for
   * closing it. The VS Code extension constructs a SerialSession directly
   * from the terminal's shared SerialLink and omits it, since that
   * connection is owned by SerialTerminal and must stay open afterward.
   */
  constructor(link: SerialLink, ownedPortCloser?: () => Promise<void>) {
    this.link = link;
    this.ownedPortCloser = ownedPortCloser;
    this.subscription = link.onData((chunk: Buffer) => {
      for (const b of chunk) {
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter(b);
        } else {
          this.queue.push(b);
        }
      }
    });
  }

  baudRate(): number {
    return this.link.baudRate?.() ?? 19200;
  }

  async close(): Promise<void> {
    this.subscription.dispose();
    await this.ownedPortCloser?.();
  }

  async writeBytes(bytes: Uint8Array): Promise<void> {
    this.link.write(Buffer.from(bytes));
    await this.link.drain?.();
  }

  async clearInput(): Promise<void> {
    this.queue.length = 0;
    await this.link.flush?.();
  }

  async readByteTimeout(timeoutMs: number): Promise<number | undefined> {
    if (this.queue.length > 0) {
      return this.queue.shift();
    }

    return new Promise<number | undefined>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(done);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        resolve(undefined);
      }, timeoutMs);

      const done = (value: number | undefined) => {
        clearTimeout(timer);
        resolve(value);
      };

      this.waiters.push(done);
    });
  }

  async echoCanAndDrain(): Promise<void> {
    await this.writeBytes(Uint8Array.from([CTRL_CAN]));
    await sleep(50);
    await this.clearInput();
  }

  async sendControl(ctrl: number, seq?: number): Promise<void> {
    if (typeof seq === "number") {
      await this.writeBytes(Uint8Array.from([ctrl, seq & 0xff]));
      return;
    }
    await this.writeBytes(Uint8Array.from([ctrl]));
  }

  async recvControl(timeoutMs: number): Promise<Control> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const b = await this.readByteTimeout(Math.min(remaining, 2000));
      if (typeof b !== "number") {
        continue;
      }

      if (b === CTRL_ACK || b === CTRL_NAK) {
        const rem = Math.max(1, deadline - Date.now());
        const seq = await this.readByteTimeout(Math.min(rem, 2000));
        if (typeof seq !== "number") {
          throw new Error("Timeout waiting for sequence byte");
        }
        return b === CTRL_ACK ? { kind: "ack", seq } : { kind: "nak", seq };
      }

      if (b === CTRL_RDY) {
        return { kind: "rdy" };
      }
      if (b === CTRL_FIN) {
        return { kind: "fin" };
      }
      if (b === CTRL_CAN) {
        await this.echoCanAndDrain();
        return { kind: "can" };
      }
    }

    throw new Error("Timeout waiting for control byte");
  }

  async recvFrame(timeoutMs: number): Promise<FrameResult> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const b = await this.readByteTimeout(Math.min(remaining, 2000));
      if (typeof b !== "number") {
        continue;
      }

      if (b === SOF) {
        return this.recvFrameAfterSof(deadline);
      }
      if (b === CTRL_FIN) {
        return { kind: "fin" };
      }
      if (b === CTRL_CAN) {
        await this.echoCanAndDrain();
        return { kind: "cancel" };
      }
    }

    throw new Error("Timeout waiting for SOF");
  }

  async recvFrameAfterSof(deadlineMs: number): Promise<FrameResult> {
    const seq = await this.readByteBefore(deadlineMs, "sequence");
    const lenH = await this.readByteBefore(deadlineMs, "len high");
    const lenL = await this.readByteBefore(deadlineMs, "len low");
    const length = ((lenH & 0xff) << 8) | (lenL & 0xff);

    const payload = await this.readExactBefore(length, deadlineMs);
    const crcH = await this.readByteBefore(deadlineMs, "crc high");
    const crcL = await this.readByteBefore(deadlineMs, "crc low");
    const rxCrc = ((crcH & 0xff) << 8) | (crcL & 0xff);

    const crcData = Buffer.alloc(3 + payload.length);
    crcData[0] = seq;
    crcData[1] = lenH;
    crcData[2] = lenL;
    payload.copy(crcData, 3);

    const calc = crc16Ccitt(crcData);
    if (calc !== rxCrc) {
      throw new Error(
        `CRC mismatch: calc=0x${calc.toString(16).padStart(4, "0")} rx=0x${rxCrc
          .toString(16)
          .padStart(4, "0")}`
      );
    }

    return { kind: "data", seq, payload };
  }

  private async readByteBefore(deadlineMs: number, label: string): Promise<number> {
    const rem = deadlineMs - Date.now();
    if (rem <= 0) {
      throw new Error(`Timeout waiting for ${label}`);
    }
    const b = await this.readByteTimeout(Math.min(rem, 2000));
    if (typeof b !== "number") {
      throw new Error(`Timeout waiting for ${label}`);
    }
    return b;
  }

  private async readExactBefore(length: number, deadlineMs: number): Promise<Buffer> {
    const out = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) {
      out[i] = await this.readByteBefore(deadlineMs, "payload");
    }
    return out;
  }
}
