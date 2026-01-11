export class OrchestratorError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "OrchestratorError";
  }
}

export class ConfigError extends OrchestratorError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ConfigError";
  }
}

export class TaskError extends OrchestratorError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "TaskError";
  }
}

export class DockerError extends OrchestratorError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "DockerError";
  }
}

export class GitError extends OrchestratorError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "GitError";
  }
}
