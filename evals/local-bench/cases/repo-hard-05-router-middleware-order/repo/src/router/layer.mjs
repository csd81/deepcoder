// Route-matching layer. NOT on the dispatch path — decoy.
export class Layer {
  constructor(path, handler) {
    this.path = path;
    this.handler = handler;
  }

  matches(path) {
    return this.path === path;
  }
}
