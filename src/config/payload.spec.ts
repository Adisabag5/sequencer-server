import { MAX_BEAT_DATA_BYTES, MAX_REQUEST_BODY_BYTES } from './payload';

describe('payload limits', () => {
  it('allows a body larger than the data it carries', () => {
    // The body also holds `title` and the object wrapping them. Equal limits
    // would mean a beat of exactly the documented size is refused by
    // body-parser with a 413 before BeatService ever sees it.
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(MAX_BEAT_DATA_BYTES);
  });

  it('leaves the documented cap at 256 KB', () => {
    expect(MAX_BEAT_DATA_BYTES).toBe(256 * 1024);
  });

  it('stays above the 100kb Express default that hid the cap', () => {
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(100 * 1024);
  });
});
