'use strict';
/** Giao diện -> Thẻ sản phẩm (/admin/card-ui): số ô mỗi hàng PC / điện thoại, cỡ icon & chữ thẻ Acc VIP */
const express = require('express');
const { setSetting, logActivity } = require('../db');
const cu = require('../services/card-ui');
const H = require('../utils/helpers');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('admin/card-ui', { title: 'Thẻ sản phẩm', c: cu.cfg(), D: cu.DEFAULTS, SIZES: cu.SIZES });
});

router.post('/', (req, res) => {
  const b = req.body;
  const c = b.reset ? {} : cu.normalize({ ...b, icons: !!b.icons, scroll: !!b.scroll });
  setSetting('card_cfg', JSON.stringify(c));
  require('./public').clearCache();
  logActivity(req.user.id, 'card_cfg', b.reset ? 'khôi phục mặc định thẻ sản phẩm' : 'cập nhật thẻ sản phẩm', H.clientIp(req));
  req.flash('success', b.reset ? 'Đã khôi phục mặc định' : 'Đã lưu cài đặt thẻ sản phẩm');
  res.redirect('/admin/card-ui');
});

module.exports = router;
