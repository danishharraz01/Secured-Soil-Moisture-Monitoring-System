/// Session countdown helpers (sessions end exactly 10 minutes after login).
library;

/// Time left until [expiresAt]; never negative.
Duration remaining(DateTime expiresAt, {DateTime? now}) {
  final left = expiresAt.difference(now ?? DateTime.now());
  return left.isNegative ? Duration.zero : left;
}

/// mm:ss, e.g. 09:41. Rounds partial seconds up so 00:00 only shows at the end.
String formatCountdown(Duration d) {
  final total = (d.inMilliseconds / 1000).ceil().clamp(0, 99 * 60 + 59);
  final minutes = (total ~/ 60).toString().padLeft(2, '0');
  final seconds = (total % 60).toString().padLeft(2, '0');
  return '$minutes:$seconds';
}

/// "just now", "45 s ago", "3 min ago", "2 h ago".
String timeAgo(DateTime then, {DateTime? now}) {
  final s = (now ?? DateTime.now()).difference(then).inSeconds;
  if (s < 5) return 'just now';
  if (s < 60) return '$s s ago';
  if (s < 3600) return '${s ~/ 60} min ago';
  if (s < 86400) return '${s ~/ 3600} h ago';
  return '${s ~/ 86400} d ago';
}
