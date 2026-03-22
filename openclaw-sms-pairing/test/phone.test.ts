import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeMobile, maskMobile } from "../src/phone.js";

describe("normalizeMobile", () => {
  it("accepts bare 11-digit number", () => {
    assert.equal(normalizeMobile("13812345678"), "13812345678");
  });
  it("strips +86 prefix", () => {
    assert.equal(normalizeMobile("+8613812345678"), "13812345678");
  });
  it("strips 0086 prefix", () => {
    assert.equal(normalizeMobile("008613812345678"), "13812345678");
  });
  it("strips 86 prefix", () => {
    assert.equal(normalizeMobile("8613812345678"), "13812345678");
  });
  it("strips spaces and dashes", () => {
    assert.equal(normalizeMobile("138-1234-5678"), "13812345678");
    assert.equal(normalizeMobile("138 1234 5678"), "13812345678");
  });
  it("strips parentheses", () => {
    assert.equal(normalizeMobile("(138)12345678"), "13812345678");
  });
  it("rejects invalid numbers", () => {
    assert.equal(normalizeMobile("12345678901"), null);
    assert.equal(normalizeMobile("1381234567"), null);
    assert.equal(normalizeMobile("138123456789"), null);
    assert.equal(normalizeMobile("abc"), null);
    assert.equal(normalizeMobile(""), null);
  });
});

describe("maskMobile", () => {
  it("masks middle digits", () => {
    assert.equal(maskMobile("13812345678"), "138****5678");
  });
});
