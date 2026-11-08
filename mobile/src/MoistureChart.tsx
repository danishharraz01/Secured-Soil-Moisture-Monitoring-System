import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import type { Reading } from './api';
import { colors } from './theme';

type Props = { readings: Reading[]; low: number; high: number };

const HEIGHT = 200;
const PAD_L = 34;
const PAD_R = 6;
const PAD_T = 8;
const PAD_B = 8;

export function MoistureChart({ readings, low, high }: Props) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const plotW = Math.max(width - PAD_L - PAD_R, 1);
  const plotH = HEIGHT - PAD_T - PAD_B;
  const n = readings.length;
  const x = (i: number) => PAD_L + (n > 1 ? (i / (n - 1)) * plotW : 0);
  const y = (v: number) => PAD_T + (1 - v / 100) * plotH;
  const barW = n > 0 ? plotW / n : 0;

  return (
    <View onLayout={onLayout} style={{ height: HEIGHT }}>
      {width > 0 && (
        <Svg width={width} height={HEIGHT}>
          {[0, 20, 40, 60, 80, 100].map((v) => (
            <Line key={`g${v}`} x1={PAD_L} x2={width - PAD_R} y1={y(v)} y2={y(v)} stroke="#eef0eb" strokeWidth={1} />
          ))}
          {[0, 50, 100].map((v) => (
            <SvgText key={`l${v}`} x={2} y={y(v) + 4} fontSize={10} fill={colors.muted}>{`${v}%`}</SvgText>
          ))}
          {readings.map((r, i) =>
            r.pump_on ? <Rect key={r.id} x={x(i) - barW / 2} y={PAD_T} width={barW} height={plotH} fill={colors.greenSoft} /> : null
          )}
          {[low, high].map((v) => (
            <Line key={`t${v}`} x1={PAD_L} x2={width - PAD_R} y1={y(v)} y2={y(v)} stroke="#9aa594" strokeDasharray="5,4" strokeWidth={1} />
          ))}
          {n > 1 && (
            <Polyline
              points={readings.map((r, i) => `${x(i)},${y(r.moisture)}`).join(' ')}
              fill="none"
              stroke={colors.blue}
              strokeWidth={2}
            />
          )}
        </Svg>
      )}
    </View>
  );
}
