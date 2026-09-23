// Gentle AI's terminal rose uses Braille dots. Keep the mark as one SVG path so
// web and native render the same monochrome silhouette at toolbar size.
const rose = [
  "             ⣠⣾⣷⣶⣦⣤⣤⣄⣠⣄⣀  ⢀⣀⣀",
  "          ⢀⣴⣿⣿⠿⣋⣭⣭⣯⣭⣍⣭⣿⣟⠛⠛⠿⣿⣷⣄",
  "      ⢀⣴⣾⡟⢻⣿⡟⠁⣼⣿⠏⣵⢻⣿⣻⣿⣿⢿⡻⣿⣿⣶⡌⢿⣿⣷⣦⣤⡄",
  "   ⣤⣶⣾⣿⣿⠏ ⠈⢿⣄ ⢹⣏⠠⠟⣾⣿⣿⣿⣿⣿⠷⣏⣼⠟⢡⣿⡟⠋⢻⣿⣿⡄",
  "   ⠈⣿⣿⣿⣿⡆   ⣽⢧⡘⠈⠳⣦⣍⠛⠛⢦⣉⣴⣛⣫⣭⣴⡟⠋  ⣾⣿⣿⡿",
  "   ⢀⠹⣿⣿⣿⣷⣤⡄ ⠋ ⠙⢆ ⣠⠴⠟⠛⣛⣛⣛⠟⠋⠁⠺⡇ ⣀⣴⣿⣿⡟⠁",
  "   ⠈⣀⠈⠛⠷⠿⣿⣿⣷⣤⣀ ⢠⠋   ⠈⠉⠉    ⣠⣴⣥⠾⠛⠉⣰⣿⣷",
  "          ⠹⣯⣝⠛⠛⠷⢶⣤⣤⣀   ⢀⡠⠖⠋⠉⢉⣀⣀⣴⣾⣿⠿⠟⠃",
  "             ⠘⠻⢿⣦⣄⡀  ⠉⠛⢦⠠⢊⠤⠴⢒⣛⣛⣩⣽⡿⠟⠁",
  "        ⠶⢶⣤⣄⡀⠨⠭⠽⠟⣓⢦⣀⠈⢇⡥⠖⠛⠋⠉⠉",
  "           ⠈⢷ ⠐⠂⢤⣽⣄ ⠰⡎⠙⠳⣄⡀ ⠈⢣⠘⢦⠋",
  "            ⠈⢳⣀⡒⠉⠉⣉⠙⡲⣽⣄ ⣏⠳⡄ ⠘⡇ ⡾⠁",
  "              ⠛⠻⢦⣄⣉⡁⣀⣀⣈⣙⣺⣌⡇⢠⢀⡇⡾",
  "                   ⠈⠉    ⠈⠳⡄⣸⢱⠇",
  "                           ⡷⠡⡯⢖⠉",
  "                        ⢀⡴⢪⠔⣉⠔⠋",
  "                           ⠐⠈",
] as const;

const dotOffsets = [
  [0, 0],
  [0, 1],
  [0, 2],
  [1, 0],
  [1, 1],
  [1, 2],
  [0, 3],
  [1, 3],
] as const;

function makeRosePath() {
  const dots: Array<readonly [number, number]> = [];
  for (const [row, line] of rose.entries()) {
    for (const [column, character] of [...line].entries()) {
      const pattern = character.codePointAt(0);
      if (pattern === undefined || pattern < 0x2800 || pattern > 0x28ff) continue;
      for (const [bit, [dx, dy]] of dotOffsets.entries()) {
        if ((pattern & (1 << bit)) !== 0) dots.push([column * 2.5 + dx, row * 4.5 + dy]);
      }
    }
  }
  const left = Math.min(...dots.map(([x]) => x));
  const right = Math.max(...dots.map(([x]) => x));
  const top = Math.min(...dots.map(([, y]) => y));
  const bottom = Math.max(...dots.map(([, y]) => y));
  const path = dots
    .map(([x, y]) => {
      const cx = x - left + 1;
      const cy = y - top + 1;
      return `M${cx - 0.31} ${cy}a.31.31 0 1 0 .62 0a.31.31 0 1 0 -.62 0`;
    })
    .join("");
  return { path, viewBox: `0 0 ${right - left + 2} ${bottom - top + 2}` };
}

export const gentleRose = makeRosePath();
