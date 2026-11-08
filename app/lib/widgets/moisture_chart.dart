/// Soil moisture line chart: 0-50 mm, dashed lines at the pump-on (low) and
/// pump-off (high) levels, shaded areas while the pump was running.
library;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../models/models.dart';
import '../theme.dart';

/// Index ranges [start, end] where the pump was on. Pure logic - unit tested.
List<(int, int)> pumpOnRanges(List<Reading> readings) {
  final ranges = <(int, int)>[];
  int? start;
  for (var i = 0; i < readings.length; i++) {
    if (readings[i].pumpOn) {
      start ??= i;
    } else if (start != null) {
      ranges.add((start, i - 1));
      start = null;
    }
  }
  if (start != null) ranges.add((start, readings.length - 1));
  return ranges;
}

class MoistureChart extends StatelessWidget {
  const MoistureChart({
    super.key,
    required this.readings,
    required this.low,
    required this.high,
  });

  final List<Reading> readings;
  final double low;
  final double high;

  @override
  Widget build(BuildContext context) {
    if (readings.length < 2) {
      return const SizedBox(
        height: 200,
        child: Center(child: Text('Waiting for readings…')),
      );
    }
    final spots = [
      for (var i = 0; i < readings.length; i++)
        FlSpot(i.toDouble(), readings[i].moistureMm),
    ];
    final timeFormat = DateFormat('HH:mm');
    final step = (readings.length / 4).ceilToDouble();

    // OFF label above its line, ON label below its line: they never overlap.
    HorizontalLine threshold(
      double y,
      Color color,
      String text,
      Alignment at,
    ) => HorizontalLine(
      y: y,
      color: color,
      strokeWidth: 1.5,
      dashArray: [6, 4],
      label: HorizontalLineLabel(
        show: true,
        alignment: at,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w600,
        ),
        labelResolver: (_) => text,
      ),
    );

    return SizedBox(
      height: 220,
      child: LineChart(
        LineChartData(
          minY: 0,
          maxY: 50,
          minX: 0,
          maxX: (readings.length - 1).toDouble(),
          clipData: const FlClipData.all(),
          gridData: FlGridData(
            drawVerticalLine: false,
            horizontalInterval: 10,
            getDrawingHorizontalLine: (_) =>
                const FlLine(color: Palette.line, strokeWidth: 1),
          ),
          borderData: FlBorderData(show: false),
          rangeAnnotations: RangeAnnotations(
            verticalRangeAnnotations: [
              for (final (start, end) in pumpOnRanges(readings))
                VerticalRangeAnnotation(
                  x1: start.toDouble(),
                  x2: (end == start ? end + 0.5 : end).toDouble(),
                  color: Palette.blue.withValues(alpha: 0.12),
                ),
            ],
          ),
          extraLinesData: ExtraLinesData(
            horizontalLines: [
              threshold(
                high,
                Palette.green,
                'OFF ≥ ${high.toStringAsFixed(1)} mm',
                Alignment.topRight,
              ),
              threshold(
                low,
                Palette.amber,
                'ON ≤ ${low.toStringAsFixed(1)} mm',
                Alignment.bottomRight,
              ),
            ],
          ),
          titlesData: FlTitlesData(
            topTitles: const AxisTitles(),
            rightTitles: const AxisTitles(),
            leftTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                interval: 10,
                reservedSize: 30,
                getTitlesWidget: (value, meta) => SideTitleWidget(
                  meta: meta,
                  child: Text(
                    value.toInt().toString(),
                    style: const TextStyle(fontSize: 11, color: Palette.muted),
                  ),
                ),
              ),
            ),
            bottomTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                interval: step,
                reservedSize: 24,
                getTitlesWidget: (value, meta) {
                  final i = value.round();
                  if (i < 0 || i >= readings.length) {
                    return const SizedBox.shrink();
                  }
                  return SideTitleWidget(
                    meta: meta,
                    child: Text(
                      timeFormat.format(readings[i].ts),
                      style: const TextStyle(
                        fontSize: 11,
                        color: Palette.muted,
                      ),
                    ),
                  );
                },
              ),
            ),
          ),
          lineTouchData: LineTouchData(
            touchTooltipData: LineTouchTooltipData(
              getTooltipItems: (touched) => [
                for (final t in touched)
                  LineTooltipItem(
                    '${t.y.toStringAsFixed(1)} mm\n${timeFormat.format(readings[t.x.round()].ts)}',
                    const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
              ],
            ),
          ),
          lineBarsData: [
            LineChartBarData(
              spots: spots,
              isCurved: true,
              curveSmoothness: 0.2,
              preventCurveOverShooting: true,
              color: Palette.green,
              barWidth: 2.5,
              dotData: const FlDotData(show: false),
              belowBarData: BarAreaData(
                show: true,
                color: Palette.green.withValues(alpha: 0.06),
              ),
            ),
          ],
        ),
        duration: Duration.zero, // live data: no animation on every poll
      ),
    );
  }
}
