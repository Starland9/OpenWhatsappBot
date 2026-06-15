const { DATABASE } = require('../../config')
const path = require('path')
const fs = require('fs')

// Initialize models
const models = {}

// Load all models
const modelsDir = path.join(__dirname, 'models')
const modelFiles = fs.readdirSync(modelsDir).filter(file => file.endsWith('.js'))

for (const file of modelFiles) {
  const modelName = path.basename(file, '.js')
  models[modelName] = require(path.join(modelsDir, file))(DATABASE)
}

// Export models and database
module.exports = {
  ...models,
  DATABASE,
  
  /**
   * Sync database
   */
  async sync() {
    await DATABASE.sync({ alter: true })
  }
}
