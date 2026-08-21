class SessionReservationRegistry {
  constructor() {
    this.reservations = new Map();
  }

  reserve(key, { sessionExists = false, creationPending = false } = {}) {
    if (sessionExists || creationPending || this.reservations.has(key)) return null;
    const token = Symbol(key);
    this.reservations.set(key, token);
    return token;
  }

  assertAvailable(key, token = null) {
    const owner = this.reservations.get(key);
    if (owner && owner !== token) {
      throw Object.assign(new Error('target session is reserved by a checkpoint fork'), {
        statusCode: 409,
        code: 'session_reserved',
      });
    }
  }

  owns(key, token) {
    return Boolean(token) && this.reservations.get(key) === token;
  }

  release(key, token) {
    if (!this.owns(key, token)) return false;
    this.reservations.delete(key);
    return true;
  }
}

export { SessionReservationRegistry };
