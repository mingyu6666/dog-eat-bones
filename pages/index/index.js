/**
 * 小狗吃骨头 - 微信小程序版
 *
 * 玩法（基于《小兔跳铃铛 / Winterbells》经典机制改编）：
 *  - 点击开始，小狗自动向上弹跳；
 *  - 按住屏幕左右拖动（桌面端悬停）控制小狗水平移动；
 *  - 踩中骨头会叼到嘴里继续弹起并得分，金骨头 +5 分；
 *  - 碰到狗粮会触发超高弹跳，蹦得特别高并 +5 分；
 *  - 踩空就会摔落，游戏结束；
 *  - 越往上骨头、狗粮越小、间距越大，难度逐步提升；
 *  - 积分旁记录跳跃高度。
 */
const STORAGE_KEY = 'dog_bone_best'
const STORAGE_HEIGHT_KEY = 'dog_bone_best_height'
const PX_PER_M = 40 // 高度换算：40px = 1 米

// 物理常量（基于秒的物理，时间戳单位为毫秒）
const G = 1100          // 重力加速度 px/s²（调低：跳得更高、下落更缓，节奏舒适）
const JUMP_BOOST = 1.15 // 起跳速度安全系数：抵消离散帧积分的高度损失（约 v*dt），保证跳跃顶点一定超过下一层线
const FOOD_BOOST = 1.85 // 狗粮超高弹跳系数（蹦得特别高）
const DOG_R = 16        // 小狗身体半径
const FEET_R = 16       // 小狗脚部碰撞半径（加宽水平命中容差）
const HIT_ZONE = 20     // 骨头命中判定容差区（层线下方像素，免疫离散帧积分误差）

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

/** 圆角矩形路径（兼容小程序旧基础库无 ctx.roundRect） */
function rr(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.lineTo(x + w - rad, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad)
  ctx.lineTo(x + w, y + h - rad)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h)
  ctx.lineTo(x + rad, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad)
  ctx.lineTo(x, y + rad)
  ctx.quadraticCurveTo(x, y, x + rad, y)
  ctx.closePath()
}

Page({
  data: {
    state: 'ready', // ready | playing | gameover
    score: 0,
    best: 0,
    height: 0,
    bestHeight: 0
  },

  onLoad() {
    const best = wx.getStorageSync(STORAGE_KEY) || 0
    const bestHeight = wx.getStorageSync(STORAGE_HEIGHT_KEY) || 0
    this.setData({ best, bestHeight })
  },

  onReady() {
    this.initCanvas()
    this.initAudio()
  },

  onUnload() {
    this.destroy()
  },

  onHide() {
    this.pauseGame()
  },

  onShow() {
    this.resumeGame()
  },

  onShareAppMessage() {
    return {
      title: `我在《小狗吃骨头》跳到了 ${this.data.score} 分、${this.data.height} 米高，来挑战我！`,
      path: '/pages/index/index'
    }
  },

  onShareTimeline() {
    return {
      title: `《小狗吃骨头》叼骨头往上跳，我拿了 ${this.data.score} 分`
    }
  },

  /* ---------- 初始化 ---------- */

  initCanvas() {
    const query = wx.createSelectorQuery()
    query
      .select('#gameCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return
        const canvas = res[0].node
        const info = wx.getWindowInfo()
        const dpr = info.pixelRatio
        const width = res[0].width
        const height = res[0].height

        canvas.width = width * dpr
        canvas.height = height * dpr
        const ctx = canvas.getContext('2d')
        ctx.scale(dpr, dpr)

        this.canvas = canvas
        this.ctx = ctx
        this.W = width
        this.H = height

        // 加载游戏背景图（公园场景，铺在画面底部）
        this.bgLoaded = false
        this.bgImg = wx.createImage()
        this.bgImg.onload = () => {
          this.bgLoaded = true
        }
        this.bgImg.src = 'assets/images/bg.jpg'

        this.initGame()
        this.lastT = 0
        this.startLoop()
      })
  },

  initAudio() {
    const create = (name, src) => {
      const a = wx.createInnerAudioContext()
      a.src = src
      this.audios = this.audios || {}
      this.audios[name] = a
    }
    create('bell', '/assets/sounds/bell.wav')
    create('star', '/assets/sounds/star.wav')
    create('fail', '/assets/sounds/fail.wav')
  },

  playSound(name) {
    const a = this.audios && this.audios[name]
    if (!a) return
    try {
      a.stop()
      a.play()
    } catch (e) {
      // 忽略音频异常
    }
  },

  vibrate(type) {
    try {
      wx.vibrateShort({ type: type || 'light' })
    } catch (e) {
      // 低版本基础库不支持 type 参数，静默忽略
    }
  },

  /* ---------- 游戏状态 ---------- */

  setGameState(s) {
    this.state = s
    this.setData({ state: s })
  },

  initGame() {
    this.score = 0
    this.state = 'ready'
    this.camera = 0 // 世界坐标 -> 屏幕坐标：screenY = worldY - camera；起始层位于屏幕 72% 高度
    this.touching = false
    this.touchX = this.W / 2
    this.particles = []
    this.foods = []
    this.carryBone = null // 小狗嘴里叼着的骨头
    this.maxHeight = 0
    this.elapsed = 0
    this.lastFoodClean = 0

    // 背景云朵（相对屏幕缓慢漂移）
    this.clouds = [
      { x: this.W * 0.15, y: this.H * 0.2, s: 0.9, speed: 8 },
      { x: this.W * 0.7, y: this.H * 0.34, s: 1.2, speed: -6 },
      { x: this.W * 0.45, y: this.H * 0.12, s: 0.7, speed: 10 }
    ]

    // 小狗（站在起始骨头顶部：骨头中心 startY，半径 40，脚在骨头顶部上方）
    this.rabbit = { x: this.W / 2, y: this.H * 0.72 - 55, vx: 0, vy: 0 }

    // 骨头层
    this.bells = []
    this.spawnStartLayer()
    for (let i = 0; i < 8; i++) {
      this.spawnLayerAbove()
    }
  },

  /** 起始层：小狗脚下的第一个大骨头 */
  spawnStartLayer() {
    const startY = this.H * 0.72
    const gap = this.nextGap()
    this.bells.push({
      x: this.W / 2,
      y: startY,
      r: 40,
      scored: true, // 已“踩过”，作为起点平台
      passed: false,
      hit: false,
      hitAt: 0,
      gold: false,
      gapNext: gap
    })
    this.lastLayerX = this.W / 2
  },

  /** 在最高层之上生成新的一层（y 更小） */
  spawnLayerAbove() {
    const top = this.bells[0]
    const gap = this.nextGap()
    const r = this.bellRadius()
    const newY = top.y - gap
    top.gapNext = gap // 踩中 top 后弹起的高度 = 到新层的距离

    const scoreNow = this.score
    const count = scoreNow >= 20 && Math.random() < 0.3 ? 2 : 1
    const margin = r + 16
    const maxStep = this.W * 0.4
    const created = []

    // 首层骨头尽量落在小狗正上方附近，保证第一跳几乎必中（建立手感信心）
    const isFirstLayer = this.bells.length === 1
    let x0 = isFirstLayer
      ? clamp(this.W / 2 + (Math.random() * 2 - 1) * 40, margin, this.W - margin)
      : clamp(
          this.lastLayerX + (Math.random() * 2 - 1) * maxStep,
          margin,
          this.W - margin
        )
    created.push({
      x: x0, y: newY, r, scored: false, passed: false,
      hit: false, hitAt: 0, gold: Math.random() < 0.12, gapNext: 0
    })

    if (count === 2) {
      const gapBetween = r * 2.6 + 30
      let x2 = x0 + (Math.random() > 0.5 ? 1 : -1) * gapBetween
      x2 = clamp(x2, margin, this.W - margin)
      if (Math.abs(x2 - x0) < r * 2.2) {
        // 太近则放到另一边
        x2 = clamp(this.W - x0, margin, this.W - margin)
      }
      created.push({
        x: x2, y: newY, r, scored: false, passed: false,
        hit: false, hitAt: 0, gold: Math.random() < 0.12, gapNext: 0
      })
    }

    this.lastLayerX = x0
    this.bells.unshift.apply(this.bells, created)

    // 层间随机狗粮（碰到触发超高弹跳）
    if (Math.random() < 0.5) {
      this.foods.push({
        x: clamp(Math.random() * this.W, 24, this.W - 24),
        y: (top.y + newY) / 2 + (Math.random() * 2 - 1) * 20,
        r: this.foodRadius(),
        hit: false,
        hitAt: 0
      })
    }
  },

  /** 保证屏幕上方始终有足够的骨头层 */
  ensureLayers() {
    let guard = 0
    while (this.bells[0].y - this.camera > 60 && guard < 10) {
      this.spawnLayerAbove()
      guard++
    }
  },

  nextGap() {
    // 层距：起点 120px，随分数缓慢拉大，封顶 230px（跳得更高更有"蹦跳感"）
    return Math.min(230, 120 + this.score * 1.8)
  },

  bellRadius() {
    // 骨头半径：起点 44px，随分数缓慢缩小，封顶 20px（越往后越小）
    return Math.max(20, 44 - this.score * 0.5)
  },

  foodRadius() {
    // 狗粮半径：随分数缓慢缩小
    return Math.max(14, 34 - this.score * 0.4)
  },

  /* ---------- 帧循环 ---------- */

  startLoop() {
    const loop = (t) => {
      if (this.destroyed) return
      const dt = this.lastT ? Math.min(0.033, (t - this.lastT) / 1000) : 0.016
      this.lastT = t
      this.elapsed += dt
      this.update(dt)
      this.render(t)
      this.raf = this.canvas.requestAnimationFrame(loop)
    }
    this.raf = this.canvas.requestAnimationFrame(loop)
  },

  pauseGame() {
    if (this.raf && this.canvas) {
      this.canvas.cancelAnimationFrame(this.raf)
      this.raf = 0
      this.lastT = 0
    }
  },

  resumeGame() {
    if (!this.canvas || this.raf || this.destroyed) return
    this.lastT = 0
    this.startLoop()
  },

  destroy() {
    this.destroyed = true
    if (this.raf && this.canvas) {
      this.canvas.cancelAnimationFrame(this.raf)
    }
    if (this.audios) {
      Object.keys(this.audios).forEach((k) => this.audios[k].destroy())
    }
  },

  /* ---------- 更新逻辑 ---------- */

  update(dt) {
    if (this.state === 'ready' || this.state === 'gameover') {
      this.updateParticles(dt)
      return
    }

    // 水平移动：按住屏幕时平滑跟随手指（响应更灵敏）
    if (this.touching) {
      const prevX = this.rabbit.x
      this.rabbit.x += (this.touchX - this.rabbit.x) * Math.min(1, 20 * dt)
      this.rabbit.vx = (this.rabbit.x - prevX) / Math.max(dt, 0.001)
    } else {
      this.rabbit.vx = 0
    }
    this.rabbit.x = clamp(this.rabbit.x, 24, this.W - 24)

    // 垂直运动
    this.rabbit.vy += G * dt
    this.rabbit.y += this.rabbit.vy * dt

    // 骨头碰撞：下落经过层线附近的判定区时判定（容差区免疫离散帧积分误差）
    const feetY = this.rabbit.y + DOG_R * 0.9
    for (const b of this.bells) {
      if (b.scored || b.passed || b.hit) continue
      const d = feetY - b.y // 脚在层线下方距离（正 = 已低于层线）
      if (d >= 0 && d <= HIT_ZONE && this.rabbit.vy > 0) {
        if (Math.abs(this.rabbit.x - b.x) <= b.r + FEET_R) {
          this.hitBell(b)
        } else if (d >= HIT_ZONE - 2) {
          b.passed = true // 已下落足够深仍未命中，视为错失该层
        }
      }
    }

    // 狗粮碰撞：碰到即触发超高弹跳
    for (const f of this.foods) {
      if (f.hit) continue
      const ry = this.rabbit.y - this.camera
      const fy = f.y - this.camera
      if (Math.abs(this.rabbit.x - f.x) < f.r + FEET_R + 6 && Math.abs(ry - fy) < f.r + DOG_R) {
        this.hitFood(f)
      }
    }

    // 相机跟随（只向上跟随，坠落时锁定）
    const targetCam = this.rabbit.y - this.H * 0.45
    if (targetCam < this.camera) {
      this.camera += (targetCam - this.camera) * 0.18
    }

    // 高度记录（40px = 1 米），只在数值变化时同步 UI
    const h = Math.max(0, Math.round(-this.camera / PX_PER_M))
    if (h > this.maxHeight) this.maxHeight = h
    if (h !== this.data.height) this.setData({ height: h })

    // 补充新层
    this.ensureLayers()

    // 清理屏幕下方已结束的层，控制数组规模
    this.cleanupLayers()

    // 清理已消失的狗粮
    if (this.elapsed - this.lastFoodClean > 2) {
      this.lastFoodClean = this.elapsed
      this.foods = this.foods.filter((f) => !f.hit || this.elapsed - f.hitAt < 1)
    }

    this.updateParticles(dt)

    // 坠落判定
    if (this.rabbit.y - this.camera > this.H + 60) {
      this.gameOver()
    }
  },

  /** 踩中骨头：叼到嘴里，钉在层线上弹起 */
  hitBell(b) {
    b.scored = true
    b.hit = true
    b.hitAt = this.elapsed
    // 叼到嘴里（小狗嘴前出现一根小骨头，直到下一次命中替换）
    this.carryBone = { r: b.r * 0.6, t: this.elapsed }
    // 关键：把小狗脚精确钉在层线上再起跳，消除离散帧判定产生的起跳点滞后
    this.rabbit.y = b.y - DOG_R * 0.9
    // 弹跳高度 = 到上方最近骨头层的实际距离
    let nearest = null
    for (const o of this.bells) {
      if (o.y < b.y && (!nearest || o.y > nearest.y)) nearest = o
    }
    const gap = nearest ? b.y - nearest.y : b.gapNext || this.nextGap()
    this.rabbit.vy = -Math.sqrt(2 * G * gap) * JUMP_BOOST
    const gain = b.gold ? 5 : 1
    this.addScore(gain)
    this.spawnParticles(b.x, b.y, b.gold ? '#ffd54f' : '#ffb74d', 12)
    this.playSound('bell')
    this.vibrate('light')
  },

  /** 碰到狗粮：超高弹跳 + 加分 */
  hitFood(f) {
    f.hit = true
    f.hitAt = this.elapsed
    // 超高弹跳：以当前层距为基础再放大（蹦得特别高）
    let nearest = null
    for (const o of this.bells) {
      if (o.y < f.y && (!nearest || o.y > nearest.y)) nearest = o
    }
    const gap = nearest ? f.y - nearest.y : this.nextGap()
    this.rabbit.vy = -Math.sqrt(2 * G * gap) * JUMP_BOOST * FOOD_BOOST
    this.addScore(5)
    this.spawnParticles(f.x, f.y, '#ffb74d', 16)
    this.spawnParticles(f.x, f.y, '#fff3e0', 8)
    this.playSound('star')
    this.vibrate('light')
  },

  addScore(n) {
    this.score += n
    this.setData({ score: this.score })
  },

  spawnParticles(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 60 + Math.random() * 140
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 60,
        life: 0.6 + Math.random() * 0.3,
        maxLife: 0.9,
        color
      })
    }
  },

  updateParticles(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vy += 500 * dt
      p.life -= dt
      if (p.life <= 0) this.particles.splice(i, 1)
    }
  },

  cleanupLayers() {
    if (this.bells.length <= 12) return
    // 移除屏幕底部较远且已结束的层
    while (
      this.bells.length > 12 &&
      this.bells[this.bells.length - 1].y - this.camera > this.H + 150 &&
      this.bells[this.bells.length - 1].scored
    ) {
      this.bells.pop()
    }
  },

  gameOver() {
    this.setGameState('gameover')
    this.touching = false
    const s = this.score
    if (s > this.data.best) {
      this.setData({ best: s })
      try {
        wx.setStorageSync(STORAGE_KEY, s)
      } catch (e) {
        // 存储失败可忽略
      }
    }
    if (this.maxHeight > this.data.bestHeight) {
      this.setData({ bestHeight: this.maxHeight })
      try {
        wx.setStorageSync(STORAGE_HEIGHT_KEY, this.maxHeight)
      } catch (e) {
        // 存储失败可忽略
      }
    }
    this.playSound('fail')
    this.vibrate('heavy')
  },

  startGame() {
    const startBell = this.bells[0]
    this.rabbit.vy = -Math.sqrt(2 * G * (startBell.gapNext || this.nextGap())) * JUMP_BOOST
    this.setGameState('playing')
    this.playSound('bell')
  },

  restart() {
    this.initGame()
    this.setData({ score: 0, height: 0 })
    this.setGameState('ready')
  },

  /* ---------- 触摸事件 ---------- */

  onTouchStart(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
    if (!t) return
    if (this.state === 'ready') {
      this.touchX = t.clientX
      this.startGame()
    }
    if (this.state === 'playing') {
      this.touching = true
      this.touchX = t.clientX
    }
  },

  onTouchMove(e) {
    const t = e.touches && e.touches[0]
    if (!t || this.state !== 'playing') return
    this.touchX = t.clientX
  },

  onTouchEnd() {
    this.touching = false
  },

  onOverlayTap() {
    if (this.state === 'ready') {
      this.startGame()
    } else if (this.state === 'gameover') {
      this.restart()
    }
  },

  /* ---------- 渲染 ---------- */

  render(t) {
    const ctx = this.ctx
    const W = this.W
    const H = this.H
    ctx.clearRect(0, 0, W, H)

    this.drawBackground(ctx, t)
    this.drawClouds(ctx, t)
    this.drawBones(ctx, t)
    this.drawFoods(ctx)
    this.drawDog(ctx)
    this.drawParticles(ctx)
  },

  drawBackground(ctx, t) {
    const W = this.W
    const H = this.H
    // 白天天空渐变（与公园背景图同色调）
    const grad = ctx.createLinearGradient(0, 0, 0, H)
    grad.addColorStop(0, '#8ec9f2')
    grad.addColorStop(0.6, '#bfe3f7')
    grad.addColorStop(1, '#e6f5fb')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, H)

    // 公园背景图：等比铺在画面底部（完整场景，草地上方为天空）
    if (this.bgLoaded && this.bgImg) {
      const bgAspect = this.bgImg.width / this.bgImg.height
      const bgH = Math.min(H * 0.55, W / bgAspect)
      ctx.drawImage(this.bgImg, 0, H - bgH, W, bgH)
    }
  },

  drawClouds(ctx, t) {
    for (const c of this.clouds) {
      c.x += c.speed * 0.016
      if (c.x > this.W + 120) c.x = -120
      if (c.x < -120) c.x = this.W + 120
      ctx.save()
      ctx.globalAlpha = 0.6
      ctx.fillStyle = '#ffffff'
      const s = c.s
      const baseY = c.y + Math.sin(t * 0.0004 + c.x) * 6
      ctx.beginPath()
      ctx.arc(c.x, baseY, 34 * s, 0, Math.PI * 2)
      ctx.arc(c.x - 30 * s, baseY + 6 * s, 24 * s, 0, Math.PI * 2)
      ctx.arc(c.x + 30 * s, baseY + 6 * s, 24 * s, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  },

  drawBones(ctx, t) {
    for (const b of this.bells) {
      const sy = b.y - this.camera
      if (sy < -80 || sy > this.H + 80) continue

      let scale = 1
      let alpha = 1
      if (b.hit) {
        const dt = (this.elapsed - b.hitAt) * 2.2
        scale = 1 + dt
        alpha = Math.max(0, 1 - dt)
        if (dt > 0.9) b.hit = false
      }

      ctx.save()
      ctx.globalAlpha = alpha * (b.scored ? 0.28 : 1)
      ctx.translate(b.x, sy)
      ctx.scale(scale, scale)

      // 金骨头光环
      if (b.gold && !b.scored) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.006 + b.x)
        ctx.globalAlpha = alpha * (0.25 + 0.25 * pulse)
        ctx.strokeStyle = '#ffd54f'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(0, 0, b.r + 6, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = alpha * (b.scored ? 0.28 : 1)
      }

      // 骨头：两端骨节 + 中间骨身（暖黄，参考素材配色）
      const boneBody = ctx.createLinearGradient(-b.r * 0.9, 0, b.r * 0.9, 0)
      if (b.gold) {
        boneBody.addColorStop(0, '#ffe082')
        boneBody.addColorStop(0.5, '#ffd54f')
        boneBody.addColorStop(1, '#f0a91e')
      } else {
        boneBody.addColorStop(0, '#ffcf6e')
        boneBody.addColorStop(0.5, '#f6b83d')
        boneBody.addColorStop(1, '#e89b2a')
      }
      // 骨身（圆角长条）
      ctx.fillStyle = boneBody
      ctx.beginPath()
      const halfLen = b.r * 0.85
      const thick = b.r * 0.34
      ctx.moveTo(-halfLen, -thick)
      ctx.quadraticCurveTo(0, -thick * 1.25, halfLen, -thick)
      ctx.lineTo(halfLen, thick)
      ctx.quadraticCurveTo(0, thick * 1.25, -halfLen, thick)
      ctx.closePath()
      ctx.fill()
      ctx.strokeStyle = '#8a5a2b'
      ctx.lineWidth = 1.6
      ctx.stroke()

      // 两端骨节（奶白圆头 + 描边）
      ctx.fillStyle = b.gold ? '#fff8dc' : '#fff6e8'
      ctx.strokeStyle = '#8a5a2b'
      ctx.lineWidth = 1.6
      for (const side of [-1, 1]) {
        ctx.beginPath()
        ctx.arc(side * (halfLen + b.r * 0.12), 0, b.r * 0.42, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        // 骨节高光
        ctx.fillStyle = 'rgba(255,255,255,0.6)'
        ctx.beginPath()
        ctx.arc(side * (halfLen + b.r * 0.12) - b.r * 0.12, -b.r * 0.14, b.r * 0.12, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = b.gold ? '#fff8dc' : '#fff6e8'
      }

      // 骨身高光
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.beginPath()
      ctx.ellipse(0, -b.r * 0.18, b.r * 0.5, b.r * 0.1, 0, 0, Math.PI * 2)
      ctx.fill()

      // 爱心小点缀（参考素材）
      ctx.fillStyle = '#ff6b6b'
      ctx.beginPath()
      ctx.moveTo(b.r * 0.45, -b.r * 0.55)
      ctx.bezierCurveTo(
        b.r * 0.3, -b.r * 0.72,
        b.r * 0.02, -b.r * 0.55,
        b.r * 0.45, -b.r * 0.3
      )
      ctx.bezierCurveTo(
        b.r * 0.88, -b.r * 0.55,
        b.r * 0.6, -b.r * 0.72,
        b.r * 0.45, -b.r * 0.55
      )
      ctx.fill()

      ctx.restore()
      ctx.globalAlpha = 1
    }
  },

  drawFoods(ctx) {
    for (const f of this.foods) {
      if (f.hit) {
        const dt = this.elapsed - f.hitAt
        if (dt > 0.6) continue
        ctx.globalAlpha = Math.max(0, 1 - dt * 1.6)
      } else {
        ctx.globalAlpha = 1
      }
      const sy = f.y - this.camera
      if (sy < -60 || sy > this.H + 60) {
        ctx.globalAlpha = 1
        continue
      }
      const r = f.r
      ctx.save()
      ctx.translate(f.x, sy)
      if (f.hit) {
        const grow = 1 + (this.elapsed - f.hitAt) * 3
        ctx.scale(grow, grow)
      }

      // 食盆（米白半圆碗 + 棕描边，参考素材配色）
      ctx.fillStyle = '#fff3e0'
      ctx.strokeStyle = '#8a5a2b'
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.ellipse(0, r * 0.1, r * 0.95, r * 0.62, 0, 0, Math.PI)
      ctx.fill()
      ctx.stroke()
      // 盆沿
      ctx.strokeStyle = '#8a5a2b'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.ellipse(0, r * 0.08, r * 0.95, r * 0.26, 0, 0, Math.PI * 2)
      ctx.stroke()
      // 蓝色爪印
      ctx.fillStyle = '#5c8fc9'
      ctx.beginPath()
      ctx.ellipse(-r * 0.25, r * 0.32, r * 0.08, r * 0.11, 0, 0, Math.PI * 2)
      ctx.ellipse(r * 0.25, r * 0.32, r * 0.08, r * 0.11, 0, 0, Math.PI * 2)
      ctx.fill()

      // 盆内狗粮颗粒（橙黄方形）
      ctx.fillStyle = '#ffb74d'
      for (const [gx, gy, gr] of [[-0.45, -0.05, 0.16], [0.1, -0.18, 0.18], [0.42, -0.02, 0.15], [-0.1, 0.18, 0.14], [0.3, 0.18, 0.13]]) {
        rr(ctx, gx * r - gr * r, gy * r - gr * r, gr * r * 2, gr * r * 2, gr * r * 0.4)
        ctx.fill()
      }
      // 颗粒高光
      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      for (const [gx, gy, gr] of [[-0.45, -0.05, 0.16], [0.1, -0.18, 0.18]]) {
        rr(ctx, gx * r - gr * r * 0.5, gy * r - gr * r * 0.6, gr * r * 0.8, gr * r * 0.5, gr * r * 0.3)
        ctx.fill()
      }

      // 光环（未命中时微微浮动）
      if (!f.hit) {
        const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 5 + f.x)
        ctx.globalAlpha = 0.15 + 0.1 * pulse
        ctx.strokeStyle = '#ffb74d'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(0, 0, r * 1.25, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.restore()
      ctx.globalAlpha = 1
    }
  },

  /** 便便狗：白色斑点狗（参考设定素材：白身黑斑、吐舌、粉腮红） */
  drawDog(ctx) {
    const r = DOG_R
    const x = this.rabbit.x
    const y = this.rabbit.y - this.camera
    const tilt = clamp(this.rabbit.vx * 0.02, -0.42, 0.42)
    const t = this.elapsed

    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(tilt)

    // 脚下柔和阴影
    ctx.fillStyle = 'rgba(0,0,0,0.12)'
    ctx.beginPath()
    ctx.ellipse(0, r * 1.12, r * 0.85, r * 0.2, 0, 0, Math.PI * 2)
    ctx.fill()

    // 尾巴（上翘短尾，轻微摆动）
    const tailWag = Math.sin(t * 8) * 0.25
    ctx.save()
    ctx.translate(r * 0.78, r * 0.45)
    ctx.rotate(-0.7 + tailWag)
    ctx.fillStyle = '#f7f2ea'
    ctx.strokeStyle = 'rgba(138,90,43,0.35)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.ellipse(0, -r * 0.28, r * 0.14, r * 0.3, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()

    // 垂耳（棕色，两侧垂下，微微扇动）
    const earSwing = Math.sin(t * 5) * 0.08
    this.drawDogEar(ctx, -r * 0.55, -r * 0.35, -0.55 + earSwing, r)
    this.drawDogEar(ctx, r * 0.55, -r * 0.35, 0.55 - earSwing, r)

    // 小短手（米白）
    ctx.fillStyle = '#fdf3ea'
    ctx.beginPath()
    ctx.ellipse(-r * 0.95, r * 0.22, r * 0.22, r * 0.3, 0.5, 0, Math.PI * 2)
    ctx.ellipse(r * 0.95, r * 0.22, r * 0.22, r * 0.3, -0.5, 0, Math.PI * 2)
    ctx.fill()

    // 身体（白色斑点狗：白底圆身）
    const bodyGrad = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.2, 0, 0, r * 1.1)
    bodyGrad.addColorStop(0, '#ffffff')
    bodyGrad.addColorStop(0.7, '#fbf6ee')
    bodyGrad.addColorStop(1, '#f0e6d8')
    ctx.fillStyle = bodyGrad
    ctx.beginPath()
    ctx.ellipse(0, 0, r, r * 1.08, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(180,140,95,0.3)'
    ctx.lineWidth = 1
    ctx.stroke()

    // 黑色斑点（便便狗特征）
    ctx.fillStyle = '#3b3b3b'
    ctx.beginPath()
    ctx.ellipse(-r * 0.5, r * 0.18, r * 0.2, r * 0.15, 0.3, 0, Math.PI * 2)
    ctx.ellipse(r * 0.42, r * 0.5, r * 0.17, r * 0.13, -0.3, 0, Math.PI * 2)
    ctx.ellipse(r * 0.08, -r * 0.62, r * 0.14, r * 0.1, 0.2, 0, Math.PI * 2)
    ctx.ellipse(-r * 0.6, r * 0.62, r * 0.12, r * 0.09, -0.2, 0, Math.PI * 2)
    ctx.fill()

    // 肚子（浅色）
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.beginPath()
    ctx.ellipse(0, r * 0.38, r * 0.5, r * 0.42, 0, 0, Math.PI * 2)
    ctx.fill()

    // 腮红（粉）
    ctx.fillStyle = 'rgba(255,150,140,0.5)'
    ctx.beginPath()
    ctx.ellipse(-r * 0.58, r * 0.16, r * 0.24, r * 0.15, 0, 0, Math.PI * 2)
    ctx.ellipse(r * 0.58, r * 0.16, r * 0.24, r * 0.15, 0, 0, Math.PI * 2)
    ctx.fill()

    // 眼睛（大而 Q，黑色，双高光）
    ctx.fillStyle = '#2b2b2b'
    ctx.beginPath()
    ctx.arc(-r * 0.32, -r * 0.18, r * 0.18, 0, Math.PI * 2)
    ctx.arc(r * 0.32, -r * 0.18, r * 0.18, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(-r * 0.27, -r * 0.24, r * 0.065, 0, Math.PI * 2)
    ctx.arc(r * 0.37, -r * 0.24, r * 0.065, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.beginPath()
    ctx.arc(-r * 0.38, -r * 0.11, r * 0.03, 0, Math.PI * 2)
    ctx.arc(r * 0.26, -r * 0.11, r * 0.03, 0, Math.PI * 2)
    ctx.fill()

    // 鼻子（黑色圆鼻头）
    ctx.fillStyle = '#2b2b2b'
    ctx.beginPath()
    ctx.ellipse(0, r * 0.02, r * 0.12, r * 0.09, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.beginPath()
    ctx.arc(-r * 0.03, -r * 0.02, r * 0.03, 0, Math.PI * 2)
    ctx.fill()

    // 吐舌头（粉红，下垂微晃）
    const tongueLen = r * 0.42 + Math.sin(t * 6) * r * 0.06
    ctx.fillStyle = '#ff8a80'
    ctx.beginPath()
    ctx.ellipse(r * 0.18, r * 0.1 + tongueLen * 0.5, r * 0.13, tongueLen * 0.5, 0.35, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(224,80,80,0.5)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(r * 0.12, r * 0.08)
    ctx.lineTo(r * 0.26, r * 0.1 + tongueLen * 0.75)
    ctx.stroke()

    // 嘴里叼着的骨头（踩中骨头后出现）
    if (this.carryBone) {
      const cr = this.carryBone.r
      ctx.save()
      ctx.translate(r * 0.68, r * 0.02)
      ctx.rotate(0.35)
      ctx.fillStyle = '#ffd54f'
      ctx.strokeStyle = '#8a5a2b'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.arc(-cr * 0.55, 0, cr * 0.45, 0, Math.PI * 2)
      ctx.arc(cr * 0.55, 0, cr * 0.45, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#ffcf6e'
      rr(ctx, -cr * 0.55, -cr * 0.3, cr * 1.1, cr * 0.6, cr * 0.2)
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }

    ctx.restore()
  },

  drawDogEar(ctx, x, y, angle, r) {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)
    const earGrad = ctx.createLinearGradient(0, -r * 0.4, 0, r * 0.45)
    earGrad.addColorStop(0, '#a0714a')
    earGrad.addColorStop(1, '#7c5230')
    ctx.fillStyle = earGrad
    ctx.beginPath()
    ctx.ellipse(0, 0, r * 0.24, r * 0.45, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    ctx.beginPath()
    ctx.ellipse(-r * 0.06, -r * 0.08, r * 0.08, r * 0.22, 0.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  },

  drawParticles(ctx) {
    for (const p of this.particles) {
      const alpha = Math.max(0, p.life / p.maxLife)
      ctx.globalAlpha = alpha
      ctx.fillStyle = p.color
      ctx.beginPath()
      ctx.arc(p.x, p.y - this.camera, 3 + alpha * 3, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }
})
