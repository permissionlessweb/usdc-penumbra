import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { keplrFingerprint, readKeplrKeys, walletToggle } from "./wallets.js";

describe("wallet toggle", () => {
  it("puts connect and disconnect on the button", () => {
    assert.deepEqual(walletToggle("Zafu", { connected: false }), {
      label: "Connect Zafu",
      disabled: false,
      title: "",
      detail: "",
    });
    assert.deepEqual(walletToggle("Keplr", { connected: true }), {
      label: "Disconnect Keplr",
      disabled: false,
      title: "",
      detail: "",
    });
    const missing = walletToggle("Zafu", { installed: false });
    assert.equal(missing.label, "Connect Zafu");
    assert.equal(missing.disabled, false);
    assert.match(missing.title, /not installed/i);
    assert.match(missing.detail, /Not installed/);
  });
});

describe("keplr account id", () => {
  afterEach(() => {
    delete globalThis.keplr;
  });

  it("changes when an address changes", () => {
    const keys = [{ chainId: "osmosis-1", bech32Address: "osmo1a", ethereumHexAddress: "" }];
    const next = [{ chainId: "osmosis-1", bech32Address: "osmo1b", ethereumHexAddress: "" }];
    assert.notEqual(keplrFingerprint(keys), keplrFingerprint(next));
    assert.equal(keplrFingerprint(keys), keplrFingerprint(keys));
  });

  it("returns null when a chain cannot be read", async () => {
    globalThis.keplr = {
      async getKey(chainId) {
        if (chainId === "noble-1") throw new Error("locked");
        return { bech32Address: `${chainId}1`, name: "a" };
      },
    };
    assert.equal(await readKeplrKeys(), null);
  });

  it("reads the three enabled keys without enabling them again", async () => {
    const asked = [];
    globalThis.keplr = {
      async enable() {
        throw new Error("enable should not run");
      },
      async getKey(chainId) {
        asked.push(chainId);
        return { bech32Address: `${chainId}-addr`, ethereumHexAddress: chainId === "injective-1" ? "0xabc" : "", name: "a" };
      },
    };
    const keys = await readKeplrKeys();
    assert.deepEqual(asked, ["osmosis-1", "noble-1", "injective-1"]);
    assert.equal(keys[2].ethereumHexAddress, "0xabc");
    assert.equal(keys.every((key) => key.error === null), true);
  });
});
