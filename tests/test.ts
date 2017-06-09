/// <reference path="./empty.d.ts" />
/// <reference path="../assembly.d.ts" />

class SomeClass {
  b: int;

  constructor(public a: int, b: int) {
    this.b = b;
  }
}

export function main(): uintptr {
  let a: Array<int> = new Array<int>(10);
  a[0] = 1;
  a[9] = 2;
  let h: SomeClass = new SomeClass(1, 2);
  h.b += 1;
  return a.length + h.a + h.b; // 14
}
