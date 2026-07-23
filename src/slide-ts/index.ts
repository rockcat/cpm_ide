import { recvSession } from "./recv.js";
import { sendSession } from "./send.js";

export type SendOptions = {
  port: string;
  files: string[];
  baud?: number;
  debug?: boolean;
};

export type RecvOptions = {
  port: string;
  outputDir?: string;
  baud?: number;
  debug?: boolean;
};

export async function send(options: SendOptions): Promise<void> {
  const baud = options.baud ?? 19200;
  const debug = options.debug ?? false;
  await sendSession(options.port, options.files, baud, debug);
}

export async function recv(options: RecvOptions): Promise<void> {
  const baud = options.baud ?? 19200;
  const debug = options.debug ?? false;
  const outputDir = options.outputDir ?? ".";
  await recvSession(options.port, baud, outputDir, debug);
}

export { sendSession, recvSession };
export { sendFiles } from "./send.js";

export {
  SOF,
  CTRL_ACK,
  CTRL_NAK,
  CTRL_RDY,
  CTRL_FIN,
  CTRL_CAN,
  WIN_SIZE,
  FRAME_SIZE,
  WAKEUP_SIG,
  crc16Ccitt,
  buildFrame,
  buildHeaderFrame,
  openSerial,
  SerialSession
} from "./protocol.js";

export type { Control, FrameResult } from "./protocol.js";
