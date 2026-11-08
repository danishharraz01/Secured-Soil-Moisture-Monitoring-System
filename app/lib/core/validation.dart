/// Input validation shared by the screens. Pure functions - unit tested.
library;

/// Server URL used when nothing has been saved yet.
/// Emulator: run `adb reverse tcp:8443 tcp:8443` so localhost reaches the PC.
const defaultServerUrl = 'https://localhost:8443';

/// Returns an error message, or null when [input] is an acceptable server URL.
///
/// Rules: must start with https:// (never plain HTTP), must have a host, and
/// must not contain credentials, a path, a query or a fragment.
String? validateServerUrl(String? input) {
  final text = input?.trim() ?? '';
  if (text.isEmpty) return 'Enter the server URL';
  if (!text.toLowerCase().startsWith('https://')) {
    return 'Server URL must start with https://';
  }
  final uri = Uri.tryParse(text);
  if (uri == null || uri.host.isEmpty) return 'Not a valid URL';
  if (uri.userInfo.isNotEmpty) return 'Do not put credentials in the URL';
  if (uri.hasQuery ||
      uri.hasFragment ||
      (uri.path.isNotEmpty && uri.path != '/')) {
    return 'Use only the address, e.g. https://localhost:8443';
  }
  if (uri.hasPort && (uri.port < 1 || uri.port > 65535)) return 'Invalid port';
  return null;
}

/// "https://Host:8443/" -> https://host:8443 (call only after validateServerUrl).
Uri normalizeServerUrl(String input) {
  final uri = Uri.parse(input.trim());
  return Uri(
    scheme: 'https',
    host: uri.host.toLowerCase(),
    port: uri.hasPort ? uri.port : null,
  );
}

/// Same rule as the server: low >= 5, high <= 50, high - low >= 2 (mm).
bool validThresholds(double low, double high) {
  return low.isFinite &&
      high.isFinite &&
      low >= 5 &&
      high <= 50 &&
      high - low >= 2 - 1e-9;
}

/// A human readable reason why thresholds are invalid, or null when valid.
String? thresholdError(double? low, double? high) {
  if (low == null || high == null) return 'Enter both values in mm';
  if (low < 5) return 'Pump-on level must be at least 5 mm';
  if (high > 50) return 'Pump-off level must be at most 50 mm';
  if (high - low < 2 - 1e-9) {
    return 'Pump-off must be at least 2 mm above pump-on';
  }
  return null;
}

/// Exactly six digits.
bool isOtpCode(String text) => RegExp(r'^\d{6}$').hasMatch(text);
