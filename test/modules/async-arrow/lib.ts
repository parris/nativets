// An exported async ARROW is an ordinary exported `const` whose initializer happens
// to be an erased async function. This shape already worked before `export async
// function` did — it is pinned here so the export-table change cannot regress it.
export const one = async (): Promise<number> => 1;

export const twice = async (n: number): Promise<number> => {
  const v = await one();
  return n * 2 + v - 1;
};
