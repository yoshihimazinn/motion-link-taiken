// 元気の木の絵。テレビ（家族ダッシュボード・結果の画面）と家族のページ（family/）で同じ描き方にする。
// buildPlantSvg が SVG の骨組み（葉の色・光の定義、地面、茎、葉の入れ物、花）を作り、renderPlantInto が段階に合わせて葉と花を描く。
// 骨組みの id（葉の色・光）は呼ぶ側が決める（1つの画面に木が2本あっても id がぶつからないように）。
// 家族のページは CSP（style-src 'self'）なので、style 属性は書かない（茎の薄さは element.style で入れる。これは CSP に当たらない）
(function (root) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  // 地面の影の色。家族ダッシュボードと結果の画面で少し違う（今のテレビの見た目のまま）
  const GROUND = {
    dashboard: { fill: "#d8d1bc", opacity: ".55" },
    result: { fill: "#d9ccb2", opacity: ".6" }
  };
  // 葉の位置と向き（下から順に出る）
  const LEAVES = [
    [126, 178, -35], [135, 156, 35], [126, 134, -38], [135, 112, 35], [126, 92, -28], [138, 92, 25]
  ];
  // 段階（0 たね・1 芽・2 若葉・3 つぼみ・4 満開）ごとの葉の数
  const VISIBLE_LEAVES = [0, 2, 4, 6, 6];

  function element(doc, name, attributes, children = []) {
    const node = doc.createElementNS(SVG_NS, name);
    for (const [key, value] of attributes) node.setAttribute(key, value);
    for (const child of children) node.appendChild(child);
    return node;
  }

  // svg の中身を骨組みで置きかえる。options：
  //   gradientId・glowId（必須）葉の色と光の id
  //   partIds   茎・葉・花の要素の id（{ stem, leaves, flower }。テレビの家族ダッシュボードの #plant-stem などのため。なくてよい）
  //   growth    true なら茎・葉・花を <g class="plant-growth"> に入れる（結果の画面の、育つときの動き）
  //   ground    地面の影の色 { fill, opacity }（既定は家族ダッシュボードの色。結果の画面は PlantView.GROUND.result）
  function buildPlantSvg(svg, options) {
    const doc = svg.ownerDocument;
    const ids = options.partIds || {};
    const ground = options.ground || GROUND.dashboard;
    const withId = (id, attributes) => (id ? [["id", id], ...attributes] : attributes);
    svg.setAttribute("viewBox", "0 0 260 240");
    svg.replaceChildren(
      element(doc, "defs", [], [
        element(doc, "linearGradient", [["id", options.gradientId], ["x1", "0"], ["y1", "0"], ["x2", "1"], ["y2", "1"]], [
          element(doc, "stop", [["stop-color", "#7fc66b"]]),
          element(doc, "stop", [["offset", "1"], ["stop-color", "#2f805e"]])
        ]),
        element(doc, "filter", [["id", options.glowId], ["x", "-20%"], ["y", "-20%"], ["width", "140%"], ["height", "140%"]], [
          element(doc, "feGaussianBlur", [["stdDeviation", "2"], ["result", "blur"]]),
          element(doc, "feMerge", [], [element(doc, "feMergeNode", [["in", "blur"]]), element(doc, "feMergeNode", [["in", "SourceGraphic"]])])
        ])
      ]),
      element(doc, "ellipse", [["cx", "130"], ["cy", "215"], ["rx", "82"], ["ry", "14"], ["fill", ground.fill], ["opacity", ground.opacity]])
    );
    const parts = [
      element(doc, "path", withId(ids.stem, [["class", "plant-stem"], ["d", "M130 210 C130 175 132 135 130 95"], ["fill", "none"], ["stroke", "#34735a"],
        ["stroke-width", "10"], ["stroke-linecap", "round"]])),
      element(doc, "g", withId(ids.leaves, [["class", "plant-leaves"]])),
      element(doc, "g", withId(ids.flower, [["class", "plant-flower"], ["hidden", ""]]), [
        [130, 72, "#f2b65c"], [114, 70, "#f7d997"], [146, 70, "#f7d997"], [130, 56, "#f7d997"], [130, 86, "#f7d997"]
      ].map(([cx, cy, fill]) => element(doc, "circle", [["cx", String(cx)], ["cy", String(cy)], ["r", "13"], ["fill", fill]])))
    ];
    if (options.growth) svg.appendChild(element(doc, "g", [["class", "plant-growth"]], parts));
    else parts.forEach((part) => svg.appendChild(part));
    return svg;
  }

  // 段階（logic.js getPlantStage の level 0〜4 と、体の分析のつや vigor 0〜5）に合わせて描く。葉の色・光は、その絵の中の定義を使う
  function renderPlantInto(svg, stage) {
    const gradientId = svg.querySelector("linearGradient").id;
    const glowId = svg.querySelector("filter").id;
    const group = svg.querySelector(".plant-leaves");
    group.innerHTML = "";
    const visibleCount = VISIBLE_LEAVES[stage.level];
    for (let i = 0; i < visibleCount; i += 1) {
      const [x, y, angle] = LEAVES[i];
      const path = svg.ownerDocument.createElementNS(SVG_NS, "path");
      path.setAttribute("d", "M0 0 C28 -23 52 -10 58 3 C31 15 10 12 0 0 Z");
      path.setAttribute("fill", `url(#${gradientId})`);
      // つや（体の分析レベル 0〜5）：段階はそのまま、葉が5%ずつ大きく、レベル2からふちに濃い緑、レベル4でやわらかい光、レベル5でふちが太く
      const scale = (i < 2 ? .75 : .9) * (1 + .05 * (stage.vigor || 0));
      path.setAttribute("transform", `translate(${x} ${y}) rotate(${angle}) scale(${scale})`);
      if (stage.vigor >= 2) {
        path.setAttribute("stroke", "#2f805e");
        path.setAttribute("stroke-width", "1.4");
      }
      if (stage.vigor >= 4) path.setAttribute("filter", `url(#${glowId})`);
      if (stage.vigor >= 5) path.setAttribute("stroke-width", "2");
      group.appendChild(path);
    }
    // SVG の要素には .hidden がないので、属性を付け外しする（.hidden = false では花が出なかった）
    svg.querySelector(".plant-flower").toggleAttribute("hidden", stage.level < 4);
    svg.querySelector(".plant-stem").style.opacity = stage.level === 0 ? ".35" : "1";
  }

  const api = { GROUND, buildPlantSvg, renderPlantInto };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MotionLinkPlantView = api;
})(typeof window !== "undefined" ? window : globalThis);
