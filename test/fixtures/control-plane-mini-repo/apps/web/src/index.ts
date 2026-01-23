import type { UserId, UserProfile } from "@acme/utils";
import { formatUserId, UserTracker } from "@acme/utils";
import "@acme/infra-terraform";

export const APP_NAME = "web-app";

export function buildProfileLink(profile: UserProfile): string {
  return `/users/${formatUserId(profile.id)}`;
}

export function createTracker(userId: UserId): UserTracker {
  return new UserTracker(userId);
}
