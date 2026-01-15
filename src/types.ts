export type AgentTool = "codex-cli" | "claude-code" | "gemini-cli" | "octofriend";
export type WorkKind = "issue" | "pr";
export type WorkflowSpec = {
  tool: AgentTool;
  workflow: string;
  params?: string;
};

export type IssueData = {
  title: string;
  body: string;
  url: string;
  comments: {
    author?: { login?: string };
    body?: string;
  }[];
  headRefName?: string;
  number?: number;
  kind?: WorkKind;
  repo?: RepoInfo;
};

export type RepoInfo = {
  nameWithOwner: string;
  defaultBranchRef?: { name?: string };
};

export type ParsedArgs = {
  target: string;
  main: WorkflowSpec;
  compare?: WorkflowSpec[];
  concurrency: number;
  commandConcurrency?: number;
  initCommand: string;
};

export type RunOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stream?: boolean;
  throwOnError?: boolean;
  terminal?: boolean;
  mockTerminateProcessTree?: boolean;
  onTerminateProcessTree?: (plan: TerminationPlan) => void;
};

export type AgentRunOptions = RunOptions & {
  agentGracePeriodMs: number;
};

export type TerminationPlan = {
  mode: "mock" | "real";
  platform: NodeJS.Platform;
  signal: NodeJS.Signals;
  pid?: number;
  processGroupId?: number;
  strategy: "no-pid" | "windows" | "darwin-tree" | "process-group" | "child-only";
  descendants?: number[];
};
