import "@acme/infra-terraform";

export type UserId = string;

export interface UserProfile {
  id: UserId;
  email: string;
}

export const DEFAULT_STATUS = "active";

export function formatUserId(userId: UserId): string {
  return userId.trim().toLowerCase();
}

export class UserTracker {
  constructor(private readonly userId: UserId) {}

  get label(): string {
    return formatUserId(this.userId);
  }
}
