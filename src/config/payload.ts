/**
 * How large a beat's pattern may be, and therefore how large a request body
 * may be. One file, because the two must agree: Express rejects an oversized
 * body before any handler runs, so a body limit below the documented cap makes
 * that cap unreachable — the service's own check never gets to speak, and the
 * caller is told the wrong thing by the wrong layer.
 */

/** The documented cap on a beat's `data` blob. */
export const MAX_BEAT_DATA_BYTES = 256 * 1024;

/**
 * The JSON body limit. Deliberately above the data cap: the body also carries
 * `title` and the object wrapping them, so a request holding a maximum-size
 * blob is a little larger than the blob itself. Set them equal and a beat of
 * exactly the documented size is refused by body-parser with a 413 instead of
 * being accepted.
 *
 * Express defaults to 100kb, which silently contradicted the 256 KB the
 * service validates and the docs promise.
 */
export const MAX_REQUEST_BODY_BYTES = MAX_BEAT_DATA_BYTES + 16 * 1024;
