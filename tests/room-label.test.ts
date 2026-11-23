// 没起名的 room 显示成员名: 两位 A ↔ B, 三位 A·B·C, 更多 A·B·C 等N人; 绝不出现「私聊」。
import assert from "node:assert/strict";
import { memberLabel } from "../shared/room-label.js";

assert.equal(memberLabel([]), "");
assert.equal(memberLabel(["a"]), "a");
assert.equal(memberLabel(["wezard-1", "OliveOwen"]), "wezard-1 ↔ OliveOwen");
assert.equal(memberLabel(["wezard-1", "OliveOwen", "MayaKing"]), "wezard-1·OliveOwen·MayaKing");
assert.equal(memberLabel(["a", "b", "c", "d", "e"]), "a·b·c 等5人");
assert.equal(memberLabel(["a", "", "b"]), "a ↔ b", "空名不占位");
for (const ns of [["a", "b"], ["a", "b", "c"], ["a", "b", "c", "d"]]) assert.ok(!memberLabel(ns).includes("私聊"));
console.log("room-label ok");
