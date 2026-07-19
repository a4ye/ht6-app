import React from 'react';
import { Image, ImageSourcePropType, StyleSheet, View } from 'react-native';

// Sprout Lands UI sprites (Cup Nooble, free basic pack, non-commercial license).
// Each panel/button is pre-sliced into 9 pieces and upscaled 6x nearest-neighbor.

export type SliceSet = {
  tl: ImageSourcePropType; t: ImageSourcePropType; tr: ImageSourcePropType;
  l: ImageSourcePropType; c: ImageSourcePropType; r: ImageSourcePropType;
  bl: ImageSourcePropType; b: ImageSourcePropType; br: ImageSourcePropType;
};

export const PANEL_CREAM: SliceSet = {
  tl: require('../../assets/ui/panelB/tl.png'),
  t: require('../../assets/ui/panelB/t.png'),
  tr: require('../../assets/ui/panelB/tr.png'),
  l: require('../../assets/ui/panelB/l.png'),
  c: require('../../assets/ui/panelB/c.png'),
  r: require('../../assets/ui/panelB/r.png'),
  bl: require('../../assets/ui/panelB/bl.png'),
  b: require('../../assets/ui/panelB/b.png'),
  br: require('../../assets/ui/panelB/br.png'),
};

export const PANEL_TAN: SliceSet = {
  tl: require('../../assets/ui/panelA/tl.png'),
  t: require('../../assets/ui/panelA/t.png'),
  tr: require('../../assets/ui/panelA/tr.png'),
  l: require('../../assets/ui/panelA/l.png'),
  c: require('../../assets/ui/panelA/c.png'),
  r: require('../../assets/ui/panelA/r.png'),
  bl: require('../../assets/ui/panelA/bl.png'),
  b: require('../../assets/ui/panelA/b.png'),
  br: require('../../assets/ui/panelA/br.png'),
};

export const BTN_CREAM: SliceSet = {
  tl: require('../../assets/ui/btnCream/tl.png'),
  t: require('../../assets/ui/btnCream/t.png'),
  tr: require('../../assets/ui/btnCream/tr.png'),
  l: require('../../assets/ui/btnCream/l.png'),
  c: require('../../assets/ui/btnCream/c.png'),
  r: require('../../assets/ui/btnCream/r.png'),
  bl: require('../../assets/ui/btnCream/bl.png'),
  b: require('../../assets/ui/btnCream/b.png'),
  br: require('../../assets/ui/btnCream/br.png'),
};

export const BTN_CREAM_PRESSED: SliceSet = {
  tl: require('../../assets/ui/btnCreamP/tl.png'),
  t: require('../../assets/ui/btnCreamP/t.png'),
  tr: require('../../assets/ui/btnCreamP/tr.png'),
  l: require('../../assets/ui/btnCreamP/l.png'),
  c: require('../../assets/ui/btnCreamP/c.png'),
  r: require('../../assets/ui/btnCreamP/r.png'),
  bl: require('../../assets/ui/btnCreamP/bl.png'),
  b: require('../../assets/ui/btnCreamP/b.png'),
  br: require('../../assets/ui/btnCreamP/br.png'),
};

export const BTN_TAN: SliceSet = {
  tl: require('../../assets/ui/btnTan/tl.png'),
  t: require('../../assets/ui/btnTan/t.png'),
  tr: require('../../assets/ui/btnTan/tr.png'),
  l: require('../../assets/ui/btnTan/l.png'),
  c: require('../../assets/ui/btnTan/c.png'),
  r: require('../../assets/ui/btnTan/r.png'),
  bl: require('../../assets/ui/btnTan/bl.png'),
  b: require('../../assets/ui/btnTan/b.png'),
  br: require('../../assets/ui/btnTan/br.png'),
};

export const BTN_TAN_PRESSED: SliceSet = {
  tl: require('../../assets/ui/btnTanP/tl.png'),
  t: require('../../assets/ui/btnTanP/t.png'),
  tr: require('../../assets/ui/btnTanP/tr.png'),
  l: require('../../assets/ui/btnTanP/l.png'),
  c: require('../../assets/ui/btnTanP/c.png'),
  r: require('../../assets/ui/btnTanP/r.png'),
  bl: require('../../assets/ui/btnTanP/bl.png'),
  b: require('../../assets/ui/btnTanP/b.png'),
  br: require('../../assets/ui/btnTanP/br.png'),
};

export const ICONS = {
  check: require('../../assets/ui/icon_check.png'),
  x: require('../../assets/ui/icon_x.png'),
  trophy: require('../../assets/ui/icon_trophy.png'),
  crown: require('../../assets/ui/icon_crown.png'),
};

// Renders a 9-slice sprite as the background of its parent (parent must be relative).
export function NineSliceBg({ set, corner = 14 }: { set: SliceSet; corner?: number }) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={{ flexDirection: 'row', height: corner }}>
        <Image source={set.tl} style={{ width: corner, height: corner }} />
        <Image source={set.t} style={{ flex: 1, height: corner }} resizeMode="stretch" />
        <Image source={set.tr} style={{ width: corner, height: corner }} />
      </View>
      <View style={{ flexDirection: 'row', flex: 1 }}>
        <Image source={set.l} style={{ width: corner, height: '100%' }} resizeMode="stretch" />
        <Image source={set.c} style={{ flex: 1, height: '100%' }} resizeMode="stretch" />
        <Image source={set.r} style={{ width: corner, height: '100%' }} resizeMode="stretch" />
      </View>
      <View style={{ flexDirection: 'row', height: corner }}>
        <Image source={set.bl} style={{ width: corner, height: corner }} />
        <Image source={set.b} style={{ flex: 1, height: corner }} resizeMode="stretch" />
        <Image source={set.br} style={{ width: corner, height: corner }} />
      </View>
    </View>
  );
}
