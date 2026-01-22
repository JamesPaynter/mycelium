export interface User {
  id: string;
}

export type UserId = string;

export enum Status {
  Active = "active",
  Disabled = "disabled",
}

export const isReady = true;

export let currentUser: User | null = null;

export function buildCli(): string {
  return "ok";
}

export class Widget {
  readonly id: UserId;

  constructor(id: UserId) {
    this.id = id;
  }
}
