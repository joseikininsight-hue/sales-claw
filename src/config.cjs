// 設定の読み取りインターフェース
// settings-manager.cjs から動的に読み取る（後方互換のためsender形式を維持）

const settings = require('./settings-manager.cjs');

module.exports = {
  get sender() {
    return settings.getSender();
  },
  get inquiryTypes() {
    return settings.get('messageTemplates', 'inquiryTypes');
  },
};
