/// Calm green / neutral look - the same palette as the Virtual Garden page.
library;

import 'package:flutter/material.dart';

class Palette {
  static const green = Color(0xFF2E7D4F);
  static const greenSoft = Color(0xFFE2F1E6);
  static const amber = Color(0xFFC96F2E);
  static const amberSoft = Color(0xFFFBEEE2);
  static const red = Color(0xFFC4302B);
  static const redSoft = Color(0xFFFBE5E3);
  static const blue = Color(0xFF2F8FC9);
  static const blueSoft = Color(0xFFE1F0F9);
  static const background = Color(0xFFF3F6F1);
  static const ink = Color(0xFF1E2B25);
  static const muted = Color(0xFF66766E);
  static const line = Color(0xFFE1E7E2);
}

ThemeData buildTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: Palette.green,
    primary: Palette.green,
    error: Palette.red,
    surface: Colors.white,
  );
  return ThemeData(
    colorScheme: scheme,
    useMaterial3: true,
    scaffoldBackgroundColor: Palette.background,
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.white,
      foregroundColor: Palette.ink,
      elevation: 0,
      scrolledUnderElevation: 0.5,
    ),
    cardTheme: CardThemeData(
      color: Colors.white,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: const BorderSide(color: Palette.line),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.white,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
    ),
    navigationBarTheme: const NavigationBarThemeData(
      backgroundColor: Colors.white,
      indicatorColor: Palette.greenSoft,
    ),
  );
}
