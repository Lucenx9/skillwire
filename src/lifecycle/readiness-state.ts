export class ReadinessState {
  private ready = false;

  public isReady(): boolean {
    return this.ready;
  }

  public markReady(): void {
    this.ready = true;
  }

  public markNotReady(): void {
    this.ready = false;
  }
}
