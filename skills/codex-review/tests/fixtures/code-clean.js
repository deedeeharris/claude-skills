'use strict';

class UserRepository {
  constructor(db) {
    this.db = db;
  }

  async findUserById(userId) {
    const rows = await this.db.query('SELECT id, email, display_name FROM users WHERE id = $1', [userId]);
    return rows[0] || null;
  }

  async createUser(email, displayName) {
    if (!email || !displayName) {
      throw new Error('email and displayName are required');
    }
    const result = await this.db.query(
      'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
      [email, displayName]
    );
    return result[0].id;
  }
}

module.exports = { UserRepository };
