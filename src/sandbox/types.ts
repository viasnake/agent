export interface SandboxInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  cleanup?: () => Promise<void>;
}

export interface SandboxRuntime {
  path: string;
  readOnly: boolean;
}
