/** TUI テスト共通ヘルパ。OpenTUI の TestRenderer で描画を検証する。 */
import {
  createTestRenderer,
  type TestRendererSetup,
} from "@opentui/core/testing";
import type { Renderable, TextChunk } from "@opentui/core";

export interface Screen extends TestRendererSetup {
  /**
   * renderable をルートへセットして 1 フレーム描画し、
   * 文字グリッドを行配列で返す。既存のルート要素は置き換える。
   */
  frame(
    renderable: Renderable,
    width?: number,
    height?: number,
  ): Promise<string[]>;
}

export async function makeScreen(width = 80, height = 24): Promise<Screen> {
  const setup = await createTestRenderer({ width, height });
  let current: Renderable | null = null;
  return {
    ...setup,
    async frame(renderable, nextWidth, nextHeight) {
      if (current && current !== renderable)
        setup.renderer.root.remove(current);
      if (current !== renderable) setup.renderer.root.add(renderable);
      current = renderable;
      if (nextWidth && nextHeight) setup.resize(nextWidth, nextHeight);
      await setup.renderOnce();
      const lines = setup.captureCharFrame().split("\n");
      // captureCharFrame は各行の末尾に \n を付けるため、split で末尾に空要素が残る。
      if (lines.at(-1) === "") lines.pop();
      return lines;
    },
  };
}

/** TextChunk の行配列をプレーンテキストに畳み込む。 */
export function chunksToText(lines: TextChunk[][]): string {
  return lines
    .map((line) => line.map((chunk) => chunk.text).join(""))
    .join("\n");
}

import { keyEventFromId, keyIdFromSequence } from "../src/tui/keys.js";
import { safeText } from "../src/tui/text.js";
import { Composer, Picker } from "../src/tui/components.js";
import { SettingsEditor } from "../src/tui/settings-editor.js";

/**
 * 生シーケンスをコンポーネントへ流すテスト用ヘルパ。
 * 制御シーケンスは handleKeyPress 経由、貼り付けと通常文字列は
 * 対象の入力欄へ挿入する（実端末入力の再現）。
 */
export function feedInput(
  target: Composer | Picker | SettingsEditor,
  data: string,
): void {
  const paste = data.match(/\x1b\[200~([\s\S]*?)\x1b\[201~/);
  if (!paste) {
    const id = keyIdFromSequence(data);
    if (id) {
      target.handleKeyPress(keyEventFromId(id));
      return;
    }
  }
  const text = safeText(paste ? paste[1]! : data);
  if (!text) return;
  const input =
    target instanceof Composer
      ? target.textarea
      : target instanceof SettingsEditor
        ? target.editing
          ? target.input
          : target.picker.input
        : target.input;
  input.insertText(text);
  if (target instanceof Picker) target.rebuild();
  if (target instanceof SettingsEditor) {
    if (target.editing) {
      const clean = safeText(target.input.value);
      if (clean !== target.input.value) target.input.value = clean;
    } else {
      target.picker.rebuild();
    }
  }
}
