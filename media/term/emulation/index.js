import { TerminalEmulation } from './base.js';
import { Vt52Emulation } from './vt52.js';
import { AnsiEmulation } from './ansi.js';

export const EMULATIONS = ['None', 'Vt52', 'ANSI'];

const CONSTRUCTORS = {
  None: TerminalEmulation,
  Vt52: Vt52Emulation,
  ANSI: AnsiEmulation,
};

export function createEmulation(name, screen, hooks) {
  const Ctor = CONSTRUCTORS[name] || TerminalEmulation;
  return new Ctor(screen, hooks);
}
