import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandQuestions, pickQuestion } from "../src/think-questions.js";

describe("questions that do not repeat", () => {
  it("fills each template with every item of its list, and keeps plain questions", () => {
    const all = expandQuestions("# a comment\n@coin = bitcoin (BTC) | ether (ETH)\nWhat is {coin} worth?\n\nWhat is new on Arc?\n");
    expect(all).toEqual(["What is bitcoin (BTC) worth?", "What is ether (ETH) worth?", "What is new on Arc?"]);
    expect(() => expandQuestions("What is {coin} worth?")).toThrow(/@coin/);
  });

  it("goes through every question once a pass, in an order that changes from pass to pass", () => {
    const all = Array.from({ length: 50 }, (_, i) => `q${i}`);
    const pass1 = Array.from({ length: 50 }, (_, n) => pickQuestion(all, n));
    const pass2 = Array.from({ length: 50 }, (_, n) => pickQuestion(all, 50 + n));
    expect(new Set(pass1).size).toBe(50);
    expect(new Set(pass2).size).toBe(50);
    expect(pass2).not.toEqual(pass1);
    // The same run number gives the same question on any machine.
    expect(pickQuestion(all, 7)).toBe(pass1[7]);
  });

  it("skips what was asked recently, even when a new list reshuffles the order", () => {
    const all = ["a", "b", "c", "d"];
    const next = pickQuestion(all, 0);
    expect(pickQuestion(all, 0, new Set([next]))).not.toBe(next);
    expect(pickQuestion(all, 0, new Set(all))).toBe(next);
  });

  it("the server's file: hundreds of questions, every template filled", () => {
    const all = expandQuestions(readFileSync(new URL("../../../deploy/think-questions.txt", import.meta.url), "utf8"));
    expect(all.length).toBeGreaterThan(400);
    expect(all.every((q) => !/\{[a-z_]+\}/i.test(q))).toBe(true);
  });
});
