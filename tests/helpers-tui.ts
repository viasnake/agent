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
