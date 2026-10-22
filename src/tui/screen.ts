/**
 * OpenTUI CliRenderer を pi-tui の TuiAltScreen 相当の API で包む薄いアダプタ。
 * app.ts 側の呼び出し形状を維持するためのもの。
 */
import {
  BoxRenderable,
  CliRenderer,
  type KeyEvent,
  type TerminalColors,
} from "@opentui/core";

export interface OverlayOptions {
  width?: string | number;
  margin?: number;
  anchor?: "center" | "bottom-center";
}

export interface TerminalColorsQuery {
  timeoutMs?: number;
  onLateReply?: (colors: TerminalColors | null) => void;
}

type Focusable = { focus(): void; blur(): void; focused?: boolean };

export class TerminalScreen {
  readonly renderer: CliRenderer;
  private overlay: BoxRenderable | null = null;
  private baseFocus: Focusable | null = null;
  private inputListeners = new Set<(key: KeyEvent) => unknown>();

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      for (const listener of this.inputListeners) {
        const result = listener(key);
        if (
          result &&
          typeof result === "object" &&
          (result as { consume?: boolean }).consume
        ) {
          key.stopPropagation();
          return;
        }
      }
    });
  }

  get columns(): number {
    return this.renderer.width;
  }
  get rows(): number {
    return this.renderer.height;
  }

  /** 端末セットアップ + 描画ループ開始（pi-tui の tui.start() 相当）。 */
  async start(): Promise<void> {
    await this.renderer.setupTerminal();
    this.renderer.start();
  }

  /** 一時停止（外部エディタ用）。 */
  async suspendScreen(): Promise<void> {
    await this.renderer.suspend();
  }

  async resumeScreen(): Promise<void> {
    await this.renderer.resume();
    this.renderer.requestRender();
  }

  /** 終了（alt screen を畳む）。 */
  stop(_options?: { preserveScreen?: boolean }): void {
    try {
      this.renderer.destroy();
    } catch {
      /* 既に破棄済みの場合は無視 */
    }
  }

  invalidate(): void {
    this.renderer.requestRender();
  }

  requestRender(_full = false): void {
    this.renderer.requestRender();
  }

  resetTextSelection(): void {
    this.renderer.clearSelection();
  }

  addInputListener(listener: (key: KeyEvent) => unknown): {
    consume: boolean;
  } {
    this.inputListeners.add(listener);
    return { consume: true };
  }

  /** pi-tui ProcessTerminal.drainInput 相当。OpenTUI では入力は集中管理されるため短い待機のみ。 */
  async drainInput(timeoutMs = 300, _intervalMs = 30): Promise<void> {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(timeoutMs, 50)),
    );
  }

  /** pi-tui queryTerminalColors 相当。パレット検出結果を返す。 */
  async queryTerminalColors(
    query: TerminalColorsQuery = {},
  ): Promise<TerminalColors | null> {
    const timeout = query.timeoutMs ?? 150;
    const colors = await Promise.race([
      this.renderer.getPalette().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout)),
    ]);
    if (colors) query.onLateReply?.(colors);
    return colors;
  }

  /** ルート配置（WorkbenchLayout）。 */
  setLayoutRoot(renderable: BoxRenderable): void {
    this.renderer.root.add(renderable);
  }

  setFocus(target: Focusable | null): void {
    if (!this.overlay) {
      this.baseFocus?.blur();
      this.baseFocus = target;
      target?.focus();
      return;
    }
    this.baseFocus = target;
  }

  hasOverlay(): boolean {
    return this.overlay !== null;
  }

  /** オーバーレイ表示。ResponsiveOverlay 以外は全画面ラッパで包む。 */
  showOverlay(content: BoxRenderable, options: OverlayOptions = {}): void {
    this.hideOverlay();
    const overlay = isOverlayRoot(content)
      ? content
      : wrapOverlay(this.renderer, content, options);
    this.overlay = overlay;
    this.renderer.root.add(overlay);
    const focusable = firstFocusable(overlay);
    if (focusable) {
      this.baseFocus?.blur();
      focusable.focus();
    }
    this.renderer.requestRender();
  }

  hideOverlay(): void {
    if (!this.overlay) return;
    const overlay = this.overlay;
    this.overlay = null;
    try {
      this.renderer.root.remove(overlay);
    } finally {
      this.baseFocus?.focus();
      this.renderer.requestRender();
    }
  }
}

function isOverlayRoot(renderable: BoxRenderable): boolean {
  return (renderable as { position?: string | number }).position === "absolute";
}

function wrapOverlay(
  renderer: CliRenderer,
  content: BoxRenderable,
  options: OverlayOptions,
): BoxRenderable {
  const overlay = new BoxRenderable(renderer, {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: options.anchor === "bottom-center" ? "flex-end" : "center",
    alignItems: "center",
    paddingX: options.margin ?? 1,
    paddingY: options.margin ?? 1,
  });
  if (options.width !== undefined) {
    content.width = options.width as number | `${number}%`;
    content.maxWidth = undefined;
  }
  overlay.add(content);
  return overlay;
}

function firstFocusable(renderable: BoxRenderable): Focusable | null {
  const candidate = renderable as Focusable & { focusable?: boolean };
  if (candidate.focusable) return candidate;
  const children = (
    renderable as unknown as { getChildren?: () => unknown[] }
  ).getChildren?.();
  for (const child of children ?? []) {
    const found = firstFocusable(child as BoxRenderable);
    if (found) return found;
  }
  return null;
}

/** pi-tui ProcessTerminal 相当の小さいファサード。 */
export class TerminalFacade {
  constructor(private readonly screen: TerminalScreen) {}
  get columns(): number {
    return this.screen.columns;
  }
  get rows(): number {
    return this.screen.rows;
  }
  async drainInput(timeoutMs = 300, intervalMs = 30): Promise<void> {
    await this.screen.drainInput(timeoutMs, intervalMs);
  }
}
