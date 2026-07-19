import React, { useMemo } from 'react';
import { Image, ImageSourcePropType, StyleSheet, useWindowDimensions, View } from 'react-native';
import { wob } from '../theme';
import { NineSliceBg, SliceSet } from './PixelUI';

// Authentic Sprout Lands world sprites (Cup Nooble basic pack, non-commercial).
const W = {
  treeSmall: require('../../assets/world/treeSmall.png'),
  treeBig: require('../../assets/world/treeBig.png'),
  treeHeart: require('../../assets/world/treeHeart.png'),
  hedgeBig: require('../../assets/world/hedgeBig.png'),
  bushBerry: require('../../assets/world/bushBerry.png'),
  mushroomsPink: require('../../assets/world/mushroomsPink.png'),
  mushroomPurple: require('../../assets/world/mushroomPurple.png'),
  sprouts: require('../../assets/world/sprouts.png'),
  rockBig: require('../../assets/world/rockBig.png'),
  stones: require('../../assets/world/stones.png'),
  log: require('../../assets/world/log.png'),
  flowerYellow: require('../../assets/world/flowerYellow.png'),
  flowerYellowBig: require('../../assets/world/flowerYellowBig.png'),
  sunflower: require('../../assets/world/sunflower.png'),
  acorn: require('../../assets/world/acorn.png'),
  pond: require('../../assets/world/pond.png'),
  lilypad: require('../../assets/world/lilypad.png'),
  fenceH: require('../../assets/world/fenceH.png'),
  decal1: require('../../assets/world/decal1.png'),
  decal2: require('../../assets/world/decal2.png'),
  decal3: require('../../assets/world/decal3.png'),
};

const GRASS: SliceSet = {
  tl: require('../../assets/world/grass/tl.png'),
  t: require('../../assets/world/grass/t.png'),
  tr: require('../../assets/world/grass/tr.png'),
  l: require('../../assets/world/grass/l.png'),
  c: require('../../assets/world/grass/c.png'),
  r: require('../../assets/world/grass/r.png'),
  bl: require('../../assets/world/grass/bl.png'),
  b: require('../../assets/world/grass/b.png'),
  br: require('../../assets/world/grass/br.png'),
};

function Spot({
  src, cx, cy, bottom, w, h, flip = false, opacity = 1,
}: {
  src: ImageSourcePropType;
  cx: number;
  cy?: number;
  bottom?: number;
  w: number;
  h: number;
  flip?: boolean;
  opacity?: number;
}) {
  const top = bottom != null ? bottom - h : (cy ?? 0) - h / 2;
  return (
    <Image
      source={src}
      style={{
        position: 'absolute',
        left: cx - w / 2,
        top,
        width: w,
        height: h,
        opacity,
        transform: flip ? [{ scaleX: -1 }] : undefined,
      }}
      resizeMode="stretch"
    />
  );
}

const TOP = 0.33; // platform top as a fraction of screen height

export default function YardScene() {
  const { width: w, height: h } = useWindowDimensions();

  // fence line along the whole crest; trees overlap it for depth
  const fences = useMemo(() => {
    const out: number[] = [];
    const seg = 92;
    for (let x = 8 + seg / 2; x < w - 8; x += seg - 4) out.push(x);
    return out;
  }, [w]);

  const decals = useMemo(
    () =>
      Array.from({ length: 10 }, (_, i) => ({
        x: (0.06 + wob(i * 7 + 3) * 0.88) * w,
        y: (TOP + 0.09 + wob(i * 13 + 5) * 0.5) * h,
        v: [W.decal1, W.decal2, W.decal3][i % 3],
        flip: wob(i * 11) > 0.5,
      })),
    [w, h]
  );

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* grass platform */}
      <View style={{ position: 'absolute', left: -24, right: -24, top: TOP * h, bottom: -60 }}>
        <NineSliceBg set={GRASS} corner={48} />
      </View>

      {/* grass texture decals */}
      {decals.map((d, i) => (
        <Spot key={`dc${i}`} src={d.v} cx={d.x} cy={d.y} w={64} h={64} flip={d.flip} opacity={0.9} />
      ))}

      {/* fence along the crest */}
      {fences.map((x, i) => (
        <Spot key={`f${i}`} src={W.fenceH} cx={x} cy={TOP * h + 16} w={92} h={46} />
      ))}

      {/* trees and hedges */}
      <Spot src={W.treeBig} cx={0.17 * w} bottom={0.49 * h} w={132} h={132} />
      <Spot src={W.treeSmall} cx={0.40 * w} bottom={0.46 * h} w={66} h={132} />
      <Spot src={W.treeHeart} cx={0.84 * w} bottom={0.495 * h} w={132} h={132} />
      <Spot src={W.hedgeBig} cx={0.61 * w} cy={0.485 * h} w={198} h={66} />

      {/* ground decor */}
      <Spot src={W.bushBerry} cx={0.30 * w} cy={0.55 * h} w={144} h={72} />
      <Spot src={W.sprouts} cx={0.45 * w} cy={0.52 * h} w={58} h={58} />
      <Spot src={W.rockBig} cx={0.52 * w} cy={0.60 * h} w={72} h={72} />
      <Spot src={W.log} cx={0.74 * w} cy={0.56 * h} w={72} h={72} flip />
      <Spot src={W.flowerYellow} cx={0.22 * w} cy={0.62 * h} w={58} h={58} />
      <Spot src={W.sprouts} cx={0.68 * w} cy={0.585 * h} w={54} h={54} flip />
      <Spot src={W.mushroomsPink} cx={0.88 * w} cy={0.60 * h} w={72} h={72} />
      <Spot src={W.mushroomPurple} cx={0.92 * w} cy={0.645 * h} w={56} h={56} />
      <Spot src={W.flowerYellowBig} cx={0.60 * w} cy={0.68 * h} w={68} h={68} />
      <Spot src={W.stones} cx={0.47 * w} cy={0.66 * h} w={58} h={58} />
      <Spot src={W.acorn} cx={0.36 * w} cy={0.70 * h} w={52} h={52} />
      <Spot src={W.sunflower} cx={0.08 * w} bottom={0.73 * h} w={72} h={144} />

      {/* pond */}
      <Spot src={W.pond} cx={0.22 * w} cy={0.87 * h} w={240} h={180} />
      <Spot src={W.lilypad} cx={0.28 * w} cy={0.885 * h} w={56} h={56} />
    </View>
  );
}
