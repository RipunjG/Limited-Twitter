/**
 * Keyword alerts.
 *
 * These fire while a sync is running, which only happens while the app is
 * open - there is no background worker by design, so nothing can notify you
 * with the tab closed.
 */

import type { AlertRule } from '@/db/schema';
import type { Tweet } from '@/x/types';

export interface CompiledAlert {
  rule: AlertRule;
  test: (text: string) => boolean;
  /** Lowercased handles this rule is limited to; empty means all. */
  handles: Set<string>;
}

export function compileAlerts(rules: AlertRule[]): CompiledAlert[] {
  const compiled: CompiledAlert[] = [];

  for (const rule of rules) {
    if (!rule.enabled || !rule.pattern.trim()) continue;

    let test: (text: string) => boolean;
    if (rule.isRegex) {
      try {
        const regex = new RegExp(rule.pattern, 'i');
        test = (text) => regex.test(text);
      } catch {
        // A malformed regex should disable its own rule, not break the sync.
        continue;
      }
    } else {
      const needle = rule.pattern.toLowerCase();
      test = (text) => text.toLowerCase().includes(needle);
    }

    compiled.push({
      rule,
      test,
      handles: new Set(rule.handles.map((handle) => handle.toLowerCase())),
    });
  }

  return compiled;
}

/** Ids of the rules a post matches. */
export function matchAlerts(tweet: Tweet, alerts: CompiledAlert[]): string[] {
  if (alerts.length === 0) return [];

  // Both handles count. On a repost `author` is whoever wrote the original,
  // so scoping an alert to the account you track would never fire without
  // also considering who reposted it.
  const handles = [tweet.author.handle.toLowerCase()];
  if (tweet.retweetedBy) handles.push(tweet.retweetedBy.handle.toLowerCase());

  // Quoted text counts: a post whose only mention of your keyword is in the
  // thing it is quoting is still a post you asked to be told about.
  const haystack = tweet.quotedTweet
    ? `${tweet.text}\n${tweet.quotedTweet.text}`
    : tweet.text;

  const matched: string[] = [];
  for (const alert of alerts) {
    if (alert.handles.size > 0 && !handles.some((h) => alert.handles.has(h))) continue;
    if (alert.test(haystack)) matched.push(alert.rule.id);
  }
  return matched;
}

export function notificationsAvailable(): boolean {
  return typeof Notification !== 'undefined';
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsAvailable()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

/**
 * Surface matched posts. Collapses a burst into one summary notification so a
 * chatty sync cannot spam the desktop.
 */
export function notifyMatches(tweets: Tweet[]): void {
  if (tweets.length === 0) return;
  if (!notificationsAvailable() || Notification.permission !== 'granted') return;

  const [first] = tweets;
  if (!first) return;

  if (tweets.length === 1) {
    const notification = new Notification(`@${first.author.handle}`, {
      body: first.text.slice(0, 200),
      icon: first.author.avatarUrl ?? undefined,
      tag: `silent-feed-${first.id}`,
    });
    notification.onclick = () => {
      window.open(first.url, '_blank', 'noopener');
      notification.close();
    };
    return;
  }

  const handles = [...new Set(tweets.map((tweet) => `@${tweet.author.handle}`))];
  const who =
    handles.length <= 3
      ? handles.join(', ')
      : `${handles.slice(0, 3).join(', ')} +${handles.length - 3} more`;

  const notification = new Notification(`${tweets.length} alert matches`, {
    body: who,
    tag: 'silent-feed-alerts',
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}
