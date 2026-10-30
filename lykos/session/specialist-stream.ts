// T215 / ADR-0044: Specialist text lives in the stream.
// When neutralHead is active, the session's head carries no specialist block,
// no off-limits notice, and no mode text. Specialist instructions, off-limits
// tools, narrowed tool lists, and the current permission mode are communicated
// via the stream:
// - at session start for the starting specialist
// - at each switch, opening with a revoking line for the previous specialist

export interface SpecialistStreamMessageOpts {
  name: string;
  instructions?: string;
  offLimits?: readonly string[];
  modeLabel: string;
  previous?: string;
  tools?: readonly string[];
}

export function specialistStreamMessage(opts: SpecialistStreamMessageOpts): string {
  const parts: string[] = [];

  if (opts.previous !== undefined && opts.previous.trim().length > 0) {
    parts.push(`The instructions of specialist \`${opts.previous}\` no longer apply.`);
  }

  parts.push(`Specialist: ${opts.name}`);

  if (opts.instructions !== undefined && opts.instructions.trim().length > 0) {
    parts.push(opts.instructions.trim());
  }

  if (opts.offLimits !== undefined && opts.offLimits.length > 0) {
    parts.push(`Tools off limits: ${opts.offLimits.join(", ")}.`);
  }

  if (opts.tools !== undefined && opts.tools.length > 0) {
    parts.push(`Available tools: ${opts.tools.join(", ")}.`);
  }

  if (opts.modeLabel) {
    parts.push(`Permission mode: ${opts.modeLabel}.`);
  }

  return parts.join("\n\n");
}
