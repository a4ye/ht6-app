const { execSync } = require("child_process");
const fs = require("fs");

const BASE = [
"....................",
"....................",
"....................",
"....................",
"......KKKKKKKK......",
".....KCCCCCCCCK.....",
"....KCHHCCCCCCCK....",
"...KCCHCCCCCCCCCK...",
"...KCCCCCCCCCCCCK...",
"...KCCEWCCCCEWCCK...",
"...KCCEECCCCEECCK...",
"...KBBCCCMMCCCBBK...",
"...KCCCCCCCCCCCCK...",
"...KSCCCCCCCCCCSK...",
"....KSCCCCCCCCSK....",
".....KSSSSSSSSK.....",
"......KKKKKKKK......",
"....................",
"....................",
"....................",
];

// species deltas: char overrides ("." keeps base)
const DELTA = {
  cat: {
    1: "......K......K......",
    2: ".....KPK....KPK.....",
    3: ".....KPPK..KPPK.....",
  },
  bear: {
    1: ".....KK......KK.....",
    2: "....KPPK....KPPK....",
    3: "....KCCK....KCCK....",
  },
  bunny: {
    0: ".....KK......KK.....",
    1: "....KPPK....KPPK....",
    2: "....KPPK....KPPK....",
    3: "....KCCK....KCCK....",
  },
  frog: {
    2: ".....KK......KK.....",
    3: "....KCCK....KCCK....",
    11: "...KBBCMMMMMMCBBK...",
  },
  duck: {
    2: "...........K........",
    3: "..........K.........",
    11: "...KBBCCOOOOCCBBK...",
  },
};

const ACC = {
  party_hat: {
    0: ".........WW.........",
    1: "........KPPK........",
    2: ".......KPPPPK.......",
    3: "......KPPPPPPK......",
    4: ".....KPPPPPPPPK.....",
  },
  beanie: {
    1: ".........WW.........",
    2: "......KKKKKKKK......",
    3: ".....KLLLLLLLLK.....",
    4: "....KLLLLLLLLLLK....",
    5: "....KKKKKKKKKKKK....",
  },
  flower_crown: {
    3: ".....PP.YY.PP.YY....",
    4: "....G..G..G..G..G...",
  },
  crown: {
    1: ".....Y..Y..Y..Y.....",
    2: ".....YYYYYYYYYY.....",
    3: ".....YYYYYYYYYY.....",
    4: ".....KKKKKKKKKK.....",
  },
  round_glasses: {
    8: "....KKKKK..KKKKK....",
    9: "....K...KKKK...K....",
    10: "....K...K..K...K....",
    11: "....KKKKK..KKKKK....",
  },
  star_glasses: {
    8: "......Y......Y......",
    9: ".....YYY.YY.YYY.....",
    10: "......Y......Y......",
  },
  sunglasses: {
    9: ".....KKKKKKKKKK.....",
    10: ".....KKKK..KKKK.....",
  },
  scarf: {
    14: "....OOOOOOOOOOOO....",
    15: ".....DDDDDDDDDD.....",
    16: "..........OO........",
    17: "..........OO........",
  },
  bowtie: {
    13: "......RR....RR......",
    14: "......RRRWWRRR......",
    15: "......RR....RR......",
  },
};

const COLORS = ["#A8D8C8", "#F5B8A0", "#C9B8E8", "#A0C8E8", "#F0D890", "#F0B8D0"];
const FIXED = {
  K: "#4A4031", E: "#4A4031", M: "#4A4031", W: "#FFFFFF",
  B: "#F2A7B3", P: "#F0A8C0", Y: "#F0C93F", L: "#7FA8D8",
  O: "#E08A5A", D: "#C96F42", R: "#D86A6A", G: "#83C167",
};
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb2hex = (r) => "#" + r.map((v) => v.toString(16).padStart(2, "0")).join("");

function emit(rows, colorHex, file) {
  const C = hex2rgb(colorHex);
  const S = rgb2hex(mix(C, [58, 48, 37], 0.25));
  const H = rgb2hex(mix(C, [255, 255, 255], 0.45));
  const lines = ["# ImageMagick pixel enumeration: 20,20,255,srgba"];
  rows.forEach((row, y) => {
    if (row.length !== 20) throw new Error(`row ${y} len ${row.length} in ${file}`);
    [...row].forEach((ch, x) => {
      let col = null;
      if (ch === ".") col = null;
      else if (ch === "C") col = colorHex;
      else if (ch === "S") col = S;
      else if (ch === "H") col = H;
      else col = FIXED[ch];
      if (!col && ch !== ".") throw new Error(`bad char ${ch}`);
      const [r, g, b] = col ? hex2rgb(col) : [0, 0, 0];
      lines.push(`${x},${y}: (${r},${g},${b},${col ? 255 : 0})`);
    });
  });
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

function merged(delta) {
  return BASE.map((row, y) => {
    const d = delta[y];
    if (!d) return row;
    return [...row].map((ch, x) => (d[x] === "." ? ch : d[x])).join("");
  });
}

fs.mkdirSync("/tmp/avtxt", { recursive: true });
const OUT = "/home/aaron/friends-thing/assets/avatar";
for (const [sp, delta] of Object.entries(DELTA)) {
  const rows = merged(delta);
  COLORS.forEach((c, i) => {
    const txt = `/tmp/avtxt/${sp}_${i}.txt`;
    emit(rows, c, txt);
    execSync(`magick txt:${txt} /tmp/avtxt/tmp1.png && magick /tmp/avtxt/tmp1.png -filter point -resize 2400% ${OUT}/${sp}_${i}.png`);
  });
}
const EMPTY = BASE.map(() => "....................");
for (const [k, delta] of Object.entries(ACC)) {
  const rows = EMPTY.map((row, y) => delta[y] ?? row);
  const txt = `/tmp/avtxt/acc_${k}.txt`;
  emit(rows, "#000000", txt);
  execSync(`magick txt:${txt} /tmp/avtxt/tmp1.png && magick /tmp/avtxt/tmp1.png -filter point -resize 2400% ${OUT}/acc_${k}.png`);
}
console.log("all sprites authored");
