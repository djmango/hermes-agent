/**
 * The host's record of a user's own composer turn.
 *
 * A plugin can read these, never produce one: `dispatchUserTurn` is called by
 * the submit pipeline only, after the gateway accepted the prompt, and this
 * module has no plugin-facing writer. The app's own transcript id travels with
 * the words, so a consumer can bind what it does to the message the person
 * actually typed instead of to text it was handed by some other path.
 *
 * What the event is NOT: proof of delivery of an answer, or a credential. A
 * consumer that writes on the person's behalf still has to use the host's
 * authenticated human session; this event only proves which turn it was.
 */

import { registry } from './registry'

/** Area id for `chat.userTurn` data contributions (`{ handle }`). */
export const USER_TURN_AREA = 'chat.userTurn'

/** One turn the person typed into the normal chat composer and sent. */
export interface UserTurn {
  /** Only the composer dispatches today. Reserved for future doors; a consumer
   *  that needs the normal chat must check it rather than assume it. */
  source: 'composer'
  /** The id the app recorded for this turn's user bubble (its transcript
   *  identity, the same id a rewind or edit targets). */
  messageId: string
  /** The live runtime session id the turn was sent to. */
  sessionId: string
  /** The durable stored-session id when this chat is bound to one. */
  storedSessionId: string | null
  /** Exactly the words the person typed (sanitized and trimmed), never the
   *  @-ref and terminal-context decoration the gateway receives. */
  text: string
  /** Epoch seconds, the clock the bubble carries. */
  at: number
}

/** Payload of a `chat.userTurn` data contribution. */
export interface UserTurnSink {
  handle: (turn: UserTurn) => void
}

/**
 * Fan an accepted composer turn to every `chat.userTurn` sink. Host-side only.
 *
 * Sinks are isolated: a throwing plugin must never break a send that already
 * landed, so each is called in its own try/catch. An empty body (attachments
 * with no words) is not a turn and is not dispatched.
 */
export function dispatchUserTurn(turn: UserTurn): void {
  if (!turn.text.trim()) {
    return
  }

  for (const contribution of registry.getArea(USER_TURN_AREA)) {
    const sink = contribution.data as UserTurnSink | undefined

    if (typeof sink?.handle !== 'function') {
      continue
    }

    try {
      sink.handle(turn)
    } catch (error) {
      console.error('[plugins] user-turn sink failed', error)
    }
  }
}
