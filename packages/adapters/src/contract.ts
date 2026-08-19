// The Adapter contract (§8.3). An adapter encapsulates one agent type's specifics;
// orchestrator/tmux call only this contract (§5.2, §8.2; FR-6/FR-11). It is a
// STATELESS singleton per type — all per-session detection state (turn token,
// output front-flag, file watch) lives in the dispatcher, not here.

import { join } from "node:path";
import type { Session, Signal } from "@muxeon/core";
import { isNotificationOnly } from "@muxeon/core";

// Detection (§5.2, FR-11/FR-11b): readyPrompt is ALWAYS declared — output (front)
// detection needs zero agent cooperation, and Muxeon never touches agent
// configuration, so it is the only path that can be relied on. statusFile is an
// OPPORTUNISTIC native accelerator: IF the agent's owner pre-installed (outside
// Muxeon) a mechanism writing { status, turn } to the convention path, the
// dispatcher takes the faster edge. The dispatcher watches BOTH paths in parallel
// and the first to fire wins; an absent/stale status file never blocks a turn.
export interface Detect {
  /** Ready-prompt pattern for output front detection (§5.2 п.2) — required. */
  readonly readyPrompt: RegExp;
  /**
   * Native status-file convention (§5.2 п.1) — the path is DERIVED FROM THE
   * SESSION deterministically so an external writer and the dispatcher agree.
   * The dispatcher accepts idle only at the current turn token — edge, not level.
   */
  statusFile?(session: Session): string;
}

/** Contents the native hook writes to its status file (§5.2). */
export interface NativeStatus {
  readonly status: "idle" | "busy";
  readonly turn: string;
}

/**
 * Which reply contract the instruction states (§13.6, FR-156). "exchange" — the
 * self-sufficient file contract: works for ANY agent that can read and write
 * files (FR-56) and is the default. "mcp" — the compact one-call form, chosen
 * only when the agent has a LIVE agent-plane session right now. Exactly one of
 * them is ever rendered: naming both paths in one instruction is what produced
 * the duplicated answer of T239 (§10.29).
 */
export type ReplyVia = "exchange" | "mcp";

/**
 * Render context (§13.2): when the dispatcher materialized the message into the
 * agent's exchange inbox (FR-52), messageFile is the absolute message.json path
 * and the render emits the SELF-SUFFICIENT file-contract instruction. Absent
 * (no exchange, e.g. tests) → the legacy MCP-hint shape.
 */
export interface RenderContext {
  readonly messageFile?: string;
  /** The reply contract to state (§13.6, FR-156); absent ⇒ "exchange". */
  readonly replyVia?: ReplyVia;
}

export interface Adapter {
  /** The config `type` this adapter serves (registry key, §7.5/§8.2). */
  readonly type: string;
  /** Message envelope → tmux injection text (§5.3, §13.2). */
  render(message: Signal, ctx?: RenderContext): string;
  /** Declarative busy→idle detection strategy (§5.2); the mechanism is the dispatcher's. */
  readonly detect: Detect;
  /**
   * Optional console-fallback (§8.2, FR-47): extract the agent's printed answer
   * from the captured pane, AFTER the delivered message's attribution line — for
   * stubborn models that answer in the terminal instead of calling `send`. The
   * extraction format is this adapter's detail; null ⇒ nothing scrapeable (an
   * operator-origin message then earns the reply-nudge, FR-45; a peer message
   * earns nothing, T61).
   */
  extractReply?(pane: string, attribution: string): string | null;
  /** Render a slash/stop command for this agent type (§4, FR-9). */
  slashCommand(name: string, args?: string): string;
}

/**
 * The default attribution preamble (§8.3): `[muxeon] from=<from> id=<id>[ replyTo=<replyTo>]`,
 * so the agent can reply with send(to=from, replyTo=id) (§8.1).
 */
export function renderAttribution(message: Signal): string {
  const parts = [`from=${message.from}`, `id=${message.id}`];
  if (message.replyTo !== undefined) parts.push(`replyTo=${message.replyTo}`);
  return `[muxeon] ${parts.join(" ")}`;
}

/**
 * The reply REFERENCE line (§12.7/§13.7, FR-178/FR-179, T292): a human quoted an
 * earlier message and this one answers it. The attribution already carries
 * `replyTo=<id>`, but an id in a header is a fact nobody acts on — this line says
 * what the id MEANS and, for an agent with a live plane, exactly how to read the
 * quoted message and the turns around it. The quoted text itself is deliberately
 * NOT inlined (operator, T292): the point of the reference is that the agent
 * fetches only what it needs, and a chat that pastes every quote back into the
 * console pays for it twice.
 *
 * Rendered ONLY for a message that came from a channel (`origin` set — webchat,
 * telegram, …). An agent answering with `send(replyTo=…)` sets the same field to
 * correlate its ANSWER (§8.3), and pointing an agent back at the question it just
 * asked is noise on every turn in the park.
 */
export function renderReplyReference(message: Signal, viaMcp: boolean): string | undefined {
  if (message.replyTo === undefined || message.origin === undefined) return undefined;
  const what = `[in reply to message ${message.replyTo} of this chat`;
  return viaMcp
    ? `${what} — read it and its context with the muxeon MCP tool: get_history(peer="${message.from}", around="${message.replyTo}")]`
    : `${what}]`;
}

/**
 * The explicit reply hint (§8.3, T57). Live finding: bare attribution is NOT
 * enough — a model answers in its terminal and never calls the tool. The hint
 * names the exact call; an agent without an MCP client simply cannot follow it
 * (receive-only, §4) and that is fine.
 */
export function renderReplyHint(message: Signal): string {
  return `[reply via the muxeon MCP tool: send(to="${message.from}", replyTo="${message.id}") — your answer as plain-text payload]`;
}

export interface RenderOptions {
  /**
   * The blob store dir <root>/blobs/ (§5.3). When set, payload blob refs render
   * as RESOLVED LOCAL PATHS (§12.5, FR-43) — agents are local CLIs, the file is
   * right there to read. Absent ⇒ refs render as opaque ids.
   */
  readonly blobsDir?: string;
  /**
   * Hybrid-injection threshold (§13.2, FR-52): a payload TEXT up to this many
   * characters is inlined into the instruction (live chat stays readable in
   * tmux); longer text is delivered only via message.json with an explicit
   * "read the file first" marker. Attachment lines always render inline —
   * message.json carries opaque blob refs, the resolved paths live here.
   */
  readonly inlineMaxChars?: number;
}

const DEFAULT_INLINE_MAX_CHARS = 1500;

/**
 * The self-sufficient file-contract instruction (§13.2, FR-52) — works for ANY
 * console agent that can read/write files, no MCP required (FR-56). Placed LAST:
 * models act on the tail of the input (T57).
 */
export function renderExchangeHint(messageFile: string, payloadInlined: boolean): string {
  // The instruction itself is ALWAYS English (§13.2, T76) — an invariant
  // protocol surface regardless of who is talking; the ANSWER must mirror the
  // request language. The deletion step is spelled out as the VERY LAST action
  // (live finding, T75): an agent that deletes message.json first ends the turn
  // early — everything it writes afterwards is collected by nobody.
  // Step 3 names the OWNER of the folder (live finding, T239): the coordinator
  // removes it only after collecting, so the dir necessarily outlives the
  // agent's delete by the collection window. An agent that kept working past
  // its own delete read that as "the exchange dropped my answer" and duplicated
  // it through MCP — both answers had in fact been delivered.
  return [
    ...(payloadInlined
      ? []
      : ["[the payload is too long for the console — READ the message file first]"]),
    `[muxeon exchange] full message: ${messageFile}`,
    "[reply contract: 1) FIRST write your answer into reply.md NEXT TO message.json (plain text / markdown), in the SAME LANGUAGE as the message itself — mirror the request language; any other files you create in that folder are sent back to the sender as attachments; 2) THEN, as your VERY LAST action, DELETE message.json — deleting it ends your turn immediately, so anything written after that is lost; 3) the coordinator collects reply.md and REMOVES that folder itself once the answer is delivered — the folder outliving your delete is normal, so do NOT inspect it afterwards and do NOT duplicate your answer through another channel]",
  ].join("\n");
}

/**
 * The compact MCP reply contract (§13.6, FR-156/FR-157) — rendered INSTEAD of the
 * file contract when the agent has a live agent-plane session. It costs the agent
 * ONE tool call where the file form costs two model round-trips (write reply.md,
 * then delete message.json), and `send` delivers mid-turn instead of at turn end
 * — that gap, not the 100ms file-detect poll, is where the file path's latency
 * actually lives.
 *
 * The message file is still named: message.json is materialized in BOTH forms
 * (the hybrid size rule §13.2 puts long payloads only there), so the agent must
 * be told where to read. What changes is the ANSWER path, not delivery.
 *
 * The other path is NEVER named here — not even to forbid it (T267). Spelling out
 * "do not write reply.md, do not delete message.json" was the original shape, and
 * it backfired twice over: a prohibition still TEACHES the alternative (this
 * instruction became the only place a compact-contract agent could learn the file
 * path exists at all, once T262 removed it from the agents' own CLAUDE.md), and
 * models follow positive constraints more reliably than negative ones. The single
 * clause "leave the message folder untouched" covers writing AND deleting while
 * naming neither. The T239 hazard it guarded against — an instruction offering two
 * ways to answer gets both used — is now carried structurally: the server does not
 * collect the exchange of an MCP-closed turn at all (§10.29).
 */
export function renderMcpExchangeHint(
  message: Signal,
  messageFile: string,
  payloadInlined: boolean,
): string {
  // English by the same invariant as the file contract (§13.2, T76); the ANSWER
  // still mirrors the request language, so that clause is repeated here — it is
  // a property of the answer, not of the transport that carries it.
  return [
    ...(payloadInlined
      ? []
      : ["[the payload is too long for the console — READ the message file first]"]),
    `[muxeon exchange] full message: ${messageFile}`,
    `[reply contract: answer with the muxeon MCP tool — send(to="${message.from}", replyTo="${message.id}"), your answer as the plain-text payload, in the SAME LANGUAGE as the message itself. That ONE call both delivers the answer and ENDS YOUR TURN, so make it your last action and leave the message folder untouched.]`,
  ].join("\n");
}

/**
 * The notice render (§19.6, FR-164): attribution, the reaction text as the operator
 * wrote it, and one closing clause. The clause distinguishes ACTING from ANSWERING —
 * an operator's reaction text may well be an instruction ("this is urgent now"), and
 * suppressing the receipt is exactly what keeps a reaction from starting an ack
 * ping-pong (§8.2). English by the same rule as every protocol surface (§13.2/T76).
 */
export function renderNotice(message: Signal, blobsDir?: string): string {
  return [
    renderAttribution(message),
    renderPayload(message.payload, blobsDir),
    "[notification — no reply is expected: act on the text above if it asks for something, but do NOT answer this message]",
  ].join("\n");
}

/**
 * Builds the default render. With an exchange context (§13.2): attribution +
 * inlined payload text (when short — the hybrid rule) + attachment lines + the
 * file-contract instruction LAST. Without one (legacy/no-exchange): attribution +
 * payload + MCP reply hint (T57). Models act on the tail of the input — with the
 * hint before the payload the live qwen agent answered the payload in its
 * terminal and never called the tool. No conversion/transcription happens here
 * (OOS-15) — the agent gets the file as-is.
 */
export function makeDefaultRender(
  options: RenderOptions = {},
): (message: Signal, ctx?: RenderContext) => string {
  const inlineMax = options.inlineMaxChars ?? DEFAULT_INLINE_MAX_CHARS;
  return (message, ctx) => {
    // A notification-only reaction (§19.6, FR-164) is the one turn that names NO
    // reply path at all — not even to forbid one (T267): naming a path is asking for
    // an answer, and this turn is a notice. The exchange skips materialization for
    // the same signal, so there is no folder to mention either.
    if (isNotificationOnly(message)) return renderNotice(message, options.blobsDir);
    if (ctx?.messageFile === undefined) {
      // Legacy shape: no exchange materialized for this turn.
      const reference = renderReplyReference(message, true);
      return [
        renderAttribution(message),
        ...(reference !== undefined ? [reference] : []),
        renderPayload(message.payload, options.blobsDir),
        renderReplyHint(message),
      ].join("\n");
    }
    const { text, attachments } = splitPayload(message.payload, options.blobsDir);
    const inline = text !== undefined && text.length <= inlineMax;
    const payloadInlined = inline || text === undefined;
    // The reference sits with the attribution, BEFORE the payload: it is a header
    // about this message, and the tail of the input belongs to the reply contract.
    const reference = renderReplyReference(message, ctx.replyVia === "mcp");
    const parts = [
      renderAttribution(message),
      ...(reference !== undefined ? [reference] : []),
      ...(inline && text !== undefined ? [text] : []),
      ...attachments, // resolved paths render ONLY here — message.json has opaque refs
      // Exactly one reply contract (§10.29): the compact MCP form only when the
      // caller resolved a live agent plane for this agent (FR-156).
      ctx.replyVia === "mcp"
        ? renderMcpExchangeHint(message, ctx.messageFile, payloadInlined)
        : renderExchangeHint(ctx.messageFile, payloadInlined),
    ];
    return parts.join("\n");
  };
}

/** Default render with opaque blob ids (the pre-§12 baseline shape). */
export const defaultRender: (message: Signal, ctx?: RenderContext) => string = makeDefaultRender();

/**
 * Raw-mode render (§14, FR-88): the payload's text VERBATIM — no attribution
 * preamble, no exchange instruction, no reply hint. The operator's text reaches
 * the terminal "as-is" so a raw turn carries zero protocol overhead; the reply is
 * the captured console (§14.2), not a `reply.md`/`send`. Media is disabled in raw
 * mode (§14.3), so the payload is normally a plain string; an object payload
 * degrades to its text part (attachments are dropped — there is nowhere to put a
 * blob path in a verbatim prompt).
 */
export function renderRaw(message: Signal): string {
  return splitPayload(message.payload).text ?? "";
}

/** Split a payload into its text part and rendered attachment lines (§12.5). */
function splitPayload(
  payload: unknown,
  blobsDir?: string,
): { text?: string; attachments: string[] } {
  if (typeof payload === "string") return { text: payload, attachments: [] };
  if (payload !== null && typeof payload === "object") {
    const { text, blobs } = payload as { text?: unknown; blobs?: unknown };
    const textPart = typeof text === "string" ? text : undefined;
    const blobLines = Array.isArray(blobs)
      ? blobs.flatMap((ref) => renderBlobLine(ref, blobsDir))
      : [];
    if (textPart !== undefined || blobLines.length > 0) {
      return { ...(textPart !== undefined ? { text: textPart } : {}), attachments: blobLines };
    }
  }
  return { text: JSON.stringify(payload), attachments: [] };
}

function renderPayload(payload: unknown, blobsDir?: string): string {
  const { text, attachments } = splitPayload(payload, blobsDir);
  return [...(text !== undefined ? [text] : []), ...attachments].join("\n");
}

// `[attachment] <name> (<mime>) → <path|id>` — readable by a human in tmux and
// parseable by an agent. A ref whose id is not a clean file-name component never
// becomes a path (defense in depth §8.7; store-issued ids always are).
function renderBlobLine(ref: unknown, blobsDir?: string): string[] {
  const id =
    typeof ref === "string"
      ? ref
      : typeof ref === "object" &&
          ref !== null &&
          typeof (ref as { blob?: unknown }).blob === "string"
        ? (ref as { blob: string }).blob
        : undefined;
  if (id === undefined) return [];
  const meta =
    typeof ref === "object" && ref !== null ? (ref as { name?: unknown; mime?: unknown }) : {};
  const name = typeof meta.name === "string" ? meta.name : id;
  const mime = typeof meta.mime === "string" ? ` (${meta.mime})` : "";
  const location = blobsDir !== undefined && isFileNameComponent(id) ? join(blobsDir, id) : id;
  return [`[attachment] ${name}${mime} → ${location}`];
}

function isFileNameComponent(id: string): boolean {
  return id.length > 0 && !/[/\\]/.test(id) && id !== "." && id !== ".." && !id.startsWith(".");
}
