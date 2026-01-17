import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, TrendingUp, AlertCircle, FolderOpen, X, Trash2, FileAudio, Loader2, ZoomIn, ZoomOut, Palette, Maximize, Minimize, Settings, Check, Music } from 'lucide-react';

// --- 常量定义 ---
const NOTE_STRINGS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const DEFAULT_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#ec4899', '#06b6d4'];
const FIXED_TIME_WINDOW = 10; // 固定时间窗口 10秒
const BOTTOM_PADDING = 40; // 底部时间轴高度常量

// --- 纯辅助函数 ---

const formatTime = (seconds) => {
  if (typeof seconds !== 'number' || isNaN(seconds)) return "0:00";
  if (seconds < 0) return "-" + formatTime(-seconds);
  
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (seconds >= 60) {
      return `${m}:${s.toString().padStart(2, '0')}`;
  } else {
      const ms = Math.floor((seconds % 1) * 10);
      return `${s}.${ms}s`;
  }
};

const getTunerColor = (c) => {
  if (typeof c !== 'number' || isNaN(c)) return 'text-gray-400';
  if (Math.abs(c) < 5) return 'text-green-400 drop-shadow-[0_0_12px_rgba(74,222,128,0.6)]';
  if (Math.abs(c) < 20) return 'text-yellow-400';
  return 'text-red-400';
};

const getNeedlePosition = (c) => {
  if (typeof c !== 'number' || isNaN(c)) return 50;
  const clamped = Math.max(-50, Math.min(50, c));
  return ((clamped + 50) / 100) * 100;
};

// 核心自相关算法
const autoCorrelateAlgorithm = (rawBuf, sampleRate) => {
  const size = rawBuf.length;
  let rms = 0;
  let maxAmp = 0;
  for (let i = 0; i < size; i++) {
    const val = rawBuf[i];
    rms += val * val;
    if (Math.abs(val) > maxAmp) maxAmp = Math.abs(val);
  }
  rms = Math.sqrt(rms / size);
  
  if (rms < 0.02) return { pitch: -1, clarity: 0 };

  const clipLimit = maxAmp * 0.4; 
  const clipBuf = new Float32Array(size);
  for (let i = 0; i < size; i++) {
      const val = rawBuf[i];
      if (val > clipLimit) clipBuf[i] = val - clipLimit;
      else if (val < -clipLimit) clipBuf[i] = val + clipLimit;
      else clipBuf[i] = 0;
  }

  const minFreq = 60;  
  const maxFreq = 1200; 
  const minPeriod = Math.floor(sampleRate / maxFreq);
  const maxPeriod = Math.floor(sampleRate / minFreq);

  let maxCorrelation = 0;
  const correlations = new Float32Array(maxPeriod + 1);
  
  for (let lag = minPeriod; lag <= maxPeriod; lag++) {
    let sum = 0;
    const n = Math.min(size - lag, 800); 
    for (let i = 0; i < n; i++) sum += clipBuf[i] * clipBuf[i + lag];
    const normCorrelation = sum / n;
    correlations[lag] = normCorrelation;
    if (normCorrelation > maxCorrelation) maxCorrelation = normCorrelation;
  }

  let clipRms = 0;
  for (let i = 0; i < size; i++) clipRms += clipBuf[i] * clipBuf[i];
  clipRms = Math.sqrt(clipRms / size);
  
  const calculatedClarity = clipRms === 0 ? 0 : maxCorrelation / (clipRms * clipRms);

  let requiredClarity = 0.85; 
  if (rms < 0.05) requiredClarity = 0.92;
  
  if (calculatedClarity < requiredClarity) return { pitch: -1, clarity: calculatedClarity }; 

  const threshold = maxCorrelation * 0.9; 
  let foundPeriod = -1;
  let bestPeriod = -1;

  for (let lag = minPeriod; lag <= maxPeriod; lag++) {
    if (correlations[lag] > threshold) {
       const prev = correlations[lag - 1] || 0;
       const next = correlations[lag + 1] || 0;
       if (correlations[lag] > prev && correlations[lag] >= next) {
           bestPeriod = lag;
           foundPeriod = lag;
           break; 
       }
    }
  }
  
  if (foundPeriod === -1) {
     return { pitch: -1, clarity: 0 };
  }

  const T0 = bestPeriod;
  const x1 = correlations[T0 - 1];
  const x2 = correlations[T0];
  const x3 = correlations[T0 + 1];
  
  let refinedPeriod = T0;
  if (x1 && x3) {
      const a = (x1 + x3 - 2 * x2) / 2;
      const b = (x3 - x1) / 2;
      if (a && a !== 0) refinedPeriod = T0 - b / (2 * a);
  }

  return { pitch: sampleRate / refinedPeriod, clarity: calculatedClarity };
};

const autoCorrelate = (rawBuf, sampleRate) => {
    return autoCorrelateAlgorithm(rawBuf, sampleRate);
};

// 绘图辅助函数
const drawGrid = (ctx, width, height, minNote, maxNote, pxPerNote) => {
  ctx.lineWidth = 1;
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const startNoteInt = Math.ceil(minNote);
  const endNoteInt = Math.floor(maxNote);

  for (let n = startNoteInt; n <= endNoteInt; n++) {
    const y = height - (n - minNote) * pxPerNote;
    const isC = n % 12 === 0; 
    ctx.strokeStyle = isC ? '#374151' : '#1f2937'; 
    if (isC) ctx.lineWidth = 2; else ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();

    if (n % 12 === 0 || n % 12 === 5 || n % 12 === 9 || (maxNote - minNote < 20)) { 
        const name = NOTE_STRINGS[n % 12];
        const oct = Math.floor(n / 12) - 1;
        ctx.fillStyle = isC ? '#6b7280' : '#4b5563';
        ctx.fillText(`${name}${oct}`, width - 5, y);
    }
  }
};

const drawTimeAxis = (ctx, width, height, startTime, endTime, isLive, padding) => {
    const axisY = height - 12; 
    const lineY = height - padding; 

    // 1. 绘制背景遮罩 (确保覆盖)
    ctx.fillStyle = '#030712'; // 使用与主背景一致的颜色
    ctx.fillRect(0, lineY, width, padding);
    
    // 2. 绘制顶部分割线
    ctx.beginPath();
    ctx.strokeStyle = '#374151'; 
    ctx.lineWidth = 1;
    ctx.moveTo(0, lineY);
    ctx.lineTo(width, lineY);
    ctx.stroke();

    const duration = endTime - startTime;
    if (!Number.isFinite(duration) || duration <= 0) return;

    // 根据时长动态计算刻度
    const magnitudes = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const targetTicks = 8;
    const roughInterval = duration / targetTicks;
    let tickInterval = magnitudes[magnitudes.length - 1];
    for (let m of magnitudes) {
        if (roughInterval <= m) {
            tickInterval = m;
            break;
        }
    }

    ctx.font = '11px monospace'; 
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9ca3af'; 

    if (isLive) {
        const ticks = 5;
        for (let i = 0; i <= ticks; i++) {
            const x = (i / ticks) * width;
            const offset = (i / ticks) * FIXED_TIME_WINDOW - (FIXED_TIME_WINDOW / 2);
            
            ctx.beginPath();
            ctx.moveTo(x, lineY);
            ctx.lineTo(x, lineY + 6);
            ctx.stroke();
            ctx.fillText(`${offset > 0 ? '+' : ''}${offset.toFixed(1)}s`, x, axisY);
        }
    } else {
        const firstTick = Math.ceil(startTime / tickInterval) * tickInterval;
        for (let t = firstTick; t <= endTime; t += tickInterval) {
            const x = ((t - startTime) / duration) * width;
            if (x >= -20 && x <= width + 20) {
                ctx.beginPath();
                ctx.moveTo(x, lineY);
                ctx.lineTo(x, lineY + 6);
                ctx.stroke();
                ctx.fillText(formatTime(t), x, axisY);
            }
        }
    }
};

const drawPlayhead = (ctx, width, height) => {
    const x = width / 2;
    const drawHeight = height - BOTTOM_PADDING;
    
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]); 
    ctx.moveTo(x, 0);
    ctx.lineTo(x, drawHeight);
    ctx.stroke();
    ctx.setLineDash([]); 
};

// --- 组件定义 ---
const PitchTuner = () => {
  const [isListening, setIsListening] = useState(false);
  const isListeningRef = useRef(false);

  const [note, setNote] = useState('-');
  const [octave, setOctave] = useState('');
  const [frequency, setFrequency] = useState(0);
  const [cents, setCents] = useState(0);
  const [error, setError] = useState('');
  const [clarity, setClarity] = useState(0);
  
  // 导入的轨道数据
  const [importedTracks, setImportedTracks] = useState([]); 
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef(null);

  // 伴奏文件数据 (新功能)
  const [accompaniment, setAccompaniment] = useState(null); // { name, buffer, duration }
  const accompanimentInputRef = useRef(null);
  const accompanimentSourceRef = useRef(null);

  const liveRecordingRef = useRef([]); 
  const recordingStartTimeRef = useRef(0);

  // 视图控制
  const [isFullView, setIsFullView] = useState(false); 
  const [viewZoom, setViewZoom] = useState(1); 
  const [viewScroll, setViewScroll] = useState(0); 

  // 音频输入设备
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef(null);
  
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const filterRef = useRef(null); 
  const rafIdRef = useRef(null);
  const canvasRef = useRef(null);
  const pitchHistoryRef = useRef([]); 
  const lastStablePitchRef = useRef(0);
  const smoothingBufferRef = useRef([]); 

  useEffect(() => {
    if (typeof window !== 'undefined' && !window.tailwind) {
      window.tailwind = { config: {} };
    }
    if (typeof document !== 'undefined' && !document.getElementById('tailwind-script')) {
      const script = document.createElement('script');
      script.id = 'tailwind-script';
      script.src = "https://cdn.tailwindcss.com";
      script.async = true;
      document.head.appendChild(script);
    }

    // 检查浏览器支持
    if (!navigator.mediaDevices) {
      console.error("浏览器不支持 navigator.mediaDevices");
      setError("浏览器不支持音频输入功能，请使用现代浏览器（Chrome、Edge、Firefox等）");
    } else {
      fetchAudioDevices();
      
      if (navigator.mediaDevices.ondevicechange !== undefined) {
        navigator.mediaDevices.ondevicechange = () => {
            console.log("检测到音频设备变化");
            fetchAudioDevices();
        };
      }
    }

    const handleClickOutside = (event) => {
      if (settingsRef.current && !settingsRef.current.contains(event.target)) {
        setShowSettings(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const fetchAudioDevices = async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        console.warn("navigator.mediaDevices 不可用，可能需要在 HTTPS 或 localhost 环境下运行");
        setError("浏览器不支持音频设备访问，请使用 HTTPS 或 localhost");
        return;
      }
      
      // 在 Windows 上，需要先请求权限才能获取设备标签
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        // 权限被拒绝不影响枚举设备，只是没有标签
      }
      
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      setAudioDevices(inputs);
      
      if (inputs.length === 0) {
        console.warn("未找到音频输入设备");
      }
    } catch (err) {
      console.error("获取音频设备失败:", err);
      setError(`无法获取音频设备列表: ${err.message || err.name || '未知错误'}`);
    }
  };

  const handleDeviceChange = async (deviceId) => {
      setSelectedDeviceId(deviceId);
      setShowSettings(false);

      if (isListeningRef.current) {
          if (sourceRef.current) {
              try {
                  sourceRef.current.disconnect();
              } catch(e) {}
          }
          if (filterRef.current) {
              try {
                  filterRef.current.disconnect();
              } catch(e) {}
          }
          
          try {
             // 重新获取流时，强制关闭回声消除等，保证纯净信号
             const constraints = {
                 audio: {
                     echoCancellation: false,
                     noiseSuppression: false,
                     autoGainControl: false
                 }
             };
             
             if (deviceId) {
                 constraints.audio.deviceId = { exact: deviceId };
             }
             
             const stream = await navigator.mediaDevices.getUserMedia(constraints);
             
             if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
                 sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
                 sourceRef.current.connect(filterRef.current);
                 filterRef.current.connect(analyserRef.current);
                 console.log("设备切换成功:", deviceId);
             } else {
                 throw new Error("音频上下文不可用");
             }
          } catch (err) {
              console.error("设备切换失败:", err);
              setError(`切换设备失败: ${err.message || err.name || '未知错误'}`);
              stopListening(); 
          }
      }
  };

  // 渲染循环
  useEffect(() => {
    try {
        if (importedTracks.length > 0) {
            requestAnimationFrame(drawFileGraph);
        } else {
            if (isListening) {
                 // 由 updatePitch 驱动 drawLiveGraph
            } else {
                const canvas = canvasRef.current;
                if (canvas) {
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#030712';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                }
            }
        }
    } catch (e) {
        console.error("Render loop error:", e);
    }
  }, [importedTracks, viewZoom, viewScroll, isListening, isFullView]); 

  const handleWheel = (e) => {
      if (importedTracks.length === 0 || !isFullView || isListening) return; 
      const delta = -Math.sign(e.deltaY) * 0.5; 
      const newZoom = Math.max(1, Math.min(50, viewZoom + delta)); 
      
      if (newZoom !== viewZoom) {
          setViewZoom(newZoom);
      }
  };

  // 处理伴奏导入 (不分析音高)
  const handleAccompanimentUpload = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      setIsProcessing(true);
      setError('');

      try {
        if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
            audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
        } else if (audioContextRef.current.state === 'suspended') {
            await audioContextRef.current.resume();
        }

        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
        
        setAccompaniment({
            name: file.name,
            buffer: audioBuffer,
            duration: audioBuffer.duration
        });

      } catch (err) {
          console.error("解析伴奏失败:", err);
          setError(`无法解析伴奏文件: ${file.name}`);
      } finally {
          setIsProcessing(false);
          if (accompanimentInputRef.current) accompanimentInputRef.current.value = '';
      }
  };

  const clearAccompaniment = () => {
      setAccompaniment(null);
      // 同时也停止可能正在播放的音频
      if (accompanimentSourceRef.current) {
          try {
            accompanimentSourceRef.current.stop();
          } catch(e) {}
          accompanimentSourceRef.current = null;
      }
  };

  // 处理分析文件导入
  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    setIsProcessing(true);
    setError('');

    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    } else if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
    }

    const newTracks = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
            const arrayBuffer = await file.arrayBuffer();
            const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
            const { data, minN, maxN } = analyzeAudioFile(audioBuffer);
            
            newTracks.push({
                id: Date.now() + i,
                name: file.name,
                data: data, 
                duration: audioBuffer.duration,
                minNote: minN, 
                maxNote: maxN, 
                color: DEFAULT_COLORS[(importedTracks.length + i) % DEFAULT_COLORS.length]
            });
        } catch (err) {
            console.error("解析音频文件失败:", err);
            setError(`无法解析文件: ${file.name}`);
        }
    }

    setImportedTracks(prev => [...prev, ...newTracks]);
    setIsProcessing(false);
    setIsFullView(true); // 导入后自动显示全局概览
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const analyzeAudioFile = (audioBuffer) => {
      const data = audioBuffer.getChannelData(0); 
      const sampleRate = audioBuffer.sampleRate;
      const hopSize = 256; 
      
      let rawResults = [];
      for (let i = 0; i < data.length; i += hopSize) {
          const chunk = data.slice(i, i + 2048);
          if (chunk.length < 2048) break;
          const { pitch } = autoCorrelateAlgorithm(chunk, sampleRate);
          const time = i / sampleRate;
          
          if (pitch > 0) {
              const noteNum = 12 * (Math.log(pitch / 440) / Math.log(2)) + 69;
              rawResults.push({ t: time, n: noteNum });
          } else {
              rawResults.push({ t: time, n: null });
          }
      }

      let filled = [...rawResults];
      for (let i = 1; i < filled.length - 1; i++) {
          if (filled[i].n === null && filled[i-1].n !== null && filled[i+1].n !== null) {
              filled[i].n = (filled[i-1].n + filled[i+1].n) / 2;
          }
      }

      const medianWindow = 5;
      let pass1 = [];
      for (let i = 0; i < filled.length; i++) {
          let window = [];
          for (let j = -Math.floor(medianWindow/2); j <= Math.floor(medianWindow/2); j++) {
              if (filled[i+j] && filled[i+j].n !== null) {
                  window.push(filled[i+j].n);
              }
          }
          if (window.length === 0) {
              pass1.push({ t: filled[i].t, n: null });
          } else {
              window.sort((a, b) => a - b);
              pass1.push({ t: filled[i].t, n: window[Math.floor(window.length / 2)] });
          }
      }

      let pass2 = pass1.map(p => ({...p})); 
      for (let i = 1; i < pass2.length - 1; i++) {
          const prev = pass2[i-1].n;
          const curr = pass2[i].n;
          const next = pass2[i+1].n;
          if (prev !== null && curr !== null && next !== null) {
              const avg = (prev + next) / 2;
              const diff = curr - avg;
              if (Math.abs(Math.abs(diff) - 12) < 1.0) {
                  pass2[i].n -= 12 * Math.sign(diff);
              } else if (Math.abs(diff) > 3) {
                  pass2[i].n = avg;
              }
          }
      }

      const weights = [1, 2, 3, 4, 3, 2, 1];
      const offset = 3;
      
      let finalResults = [];
      let minN = Infinity;
      let maxN = -Infinity;

      for (let i = 0; i < pass2.length; i++) {
          if (pass2[i].n === null) {
              finalResults.push({ t: pass2[i].t, n: null });
              continue;
          }

          let sum = 0;
          let wSum = 0;
          for (let j = 0; j < weights.length; j++) {
              const idx = i + j - offset;
              if (pass2[idx] && pass2[idx].n !== null) {
                  sum += pass2[idx].n * weights[j];
                  wSum += weights[j];
              }
          }
          
          if (wSum > 0) {
              const val = sum / wSum;
              finalResults.push({ t: pass2[i].t, n: val });
              if (val < minN) minN = val;
              if (val > maxN) maxN = val;
          } else {
              finalResults.push({ t: pass2[i].t, n: null });
          }
      }

      return { data: finalResults, minN, maxN };
  };

  const updateTrackColor = (id, newColor) => {
      setImportedTracks(prev => prev.map(t => 
          t.id === id ? { ...t, color: newColor } : t
      ));
  };

  const removeTrack = (id) => {
      setImportedTracks(prev => {
          const newTracks = prev.filter(t => t.id !== id);
          if (newTracks.length === 0 && !isListeningRef.current) {
              // 状态更新是异步的，这里不能立即画，依赖 useEffect 清理
          }
          return newTracks;
      });
  };

  const drawLiveGraph = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    ctx.fillStyle = '#030712'; 
    ctx.fillRect(0, 0, width, height);

    const validNotes = pitchHistoryRef.current.filter(n => n !== null);
    let minNote = 57; 
    let maxNote = 81;
    if (validNotes.length > 0) {
      minNote = Math.min(...validNotes) - 2; 
      maxNote = Math.max(...validNotes) + 2;
    }
    if (maxNote - minNote < 12) {
       const center = (maxNote + minNote) / 2;
       minNote = center - 6;
       maxNote = center + 6;
    }
    
    const drawHeight = height - BOTTOM_PADDING;
    const noteRange = maxNote - minNote;
    const pxPerNote = drawHeight / noteRange;

    try {
        ctx.save();
        ctx.beginPath();
        // 关键：Clip 区域不包含底部时间轴
        ctx.rect(0, 0, width, drawHeight);
        ctx.clip(); 

        drawGrid(ctx, width, drawHeight, minNote, maxNote, pxPerNote);
        drawPlayhead(ctx, width, height);
        
        ctx.beginPath();
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#22c55e'; 
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#22c55e';

        const totalPoints = pitchHistoryRef.current.length;
        const maxFrames = FIXED_TIME_WINDOW * 60; // 使用固定窗口 10s
        
        for (let i = 0; i < totalPoints; i++) {
          const n = pitchHistoryRef.current[i];
          // 将最新的点置于屏幕中央 (width/2)
          const pointsFromNow = totalPoints - 1 - i;
          const x = (width / 2) - (pointsFromNow / maxFrames) * width;
          
          if (n === null) {
            ctx.stroke();
            ctx.beginPath();
            continue;
          }
          const y = drawHeight - (n - minNote) * pxPerNote;
          
          if (x >= -50 && x <= width + 50) {
              if (i === 0 || pitchHistoryRef.current[i-1] === null) {
                ctx.moveTo(x, y);
              } else {
                ctx.lineTo(x, y);
              }
          }
        }
        ctx.stroke();
        
        const lastNote = pitchHistoryRef.current[pitchHistoryRef.current.length - 1];
        if (lastNote !== null && lastNote !== undefined) {
           const y = drawHeight - (lastNote - minNote) * pxPerNote;
           ctx.fillStyle = '#ef4444'; 
           ctx.beginPath();
           ctx.arc(width / 2, y, 5, 0, Math.PI * 2); // 点画在中间
           ctx.fill();
        }
    } catch (e) {
        console.error("Live draw error:", e);
    } finally {
        ctx.restore(); 
    }

    drawTimeAxis(ctx, width, height, 0, FIXED_TIME_WINDOW, true, BOTTOM_PADDING);
  };

  const drawFileGraph = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#030712';
      ctx.fillRect(0, 0, width, height);

      let maxDuration = 0;
      let minN = Infinity;
      let maxN = -Infinity;

      importedTracks.forEach(track => {
          if (track.duration > maxDuration) maxDuration = track.duration;
          if (track.minNote !== undefined && track.minNote < minN) minN = track.minNote;
          if (track.maxNote !== undefined && track.maxNote > maxN) maxN = track.maxNote;
      });
      
      if (liveRecordingRef.current.length > 0) {
          liveRecordingRef.current.forEach(pt => {
              if (pt.n !== null) {
                  if (pt.n < minN) minN = pt.n;
                  if (pt.n > maxN) maxN = pt.n;
              }
          });
      }

      if (maxDuration === 0) maxDuration = 10;

      // --- 视图计算 ---
      let visibleDuration, startTime, endTime;

      if (isFullView) {
          visibleDuration = maxDuration / viewZoom;
          startTime = viewScroll * (maxDuration - visibleDuration); 
          endTime = startTime + visibleDuration;
      } else {
          // Follow Mode: 始终以当前时间为中心
          let now = 0;
          if (isListeningRef.current && audioContextRef.current) {
              now = audioContextRef.current.currentTime - recordingStartTimeRef.current;
          } else if (liveRecordingRef.current.length > 0) {
              now = liveRecordingRef.current[liveRecordingRef.current.length - 1].t;
          }
          
          visibleDuration = FIXED_TIME_WINDOW; 
          startTime = now - (visibleDuration / 2);
          endTime = now + (visibleDuration / 2);
      }

      let minNote = 57;
      let maxNote = 81;
      
      if (minN !== Infinity && maxN !== -Infinity) {
          minNote = minN - 2;
          maxNote = maxN + 2;
      }

      if (maxNote - minNote < 12) {
          const center = (maxNote + minNote) / 2;
          minNote = center - 6;
          maxNote = center + 6;
      }
      
      const drawHeight = height - BOTTOM_PADDING;
      const noteRange = maxNote - minNote;
      const pxPerNote = drawHeight / noteRange;

      try {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, width, drawHeight);
          ctx.clip();

          drawGrid(ctx, width, drawHeight, minNote, maxNote, pxPerNote);
          // 在跟随模式下绘制中央参考线
          if (!isFullView) drawPlayhead(ctx, width, height);

          importedTracks.forEach(track => {
              ctx.beginPath();
              ctx.lineWidth = 3; 
              ctx.strokeStyle = track.color;
              ctx.lineJoin = 'round';
              ctx.lineCap = 'round';
              ctx.shadowBlur = 0;
              ctx.globalAlpha = 0.9; 

              let isDrawing = false;
              const dt = track.data.length > 1 ? track.data[1].t - track.data[0].t : 0.01;
              const startIndex = Math.max(0, Math.floor((startTime - 1) / dt));
              const endIndex = Math.min(track.data.length, Math.ceil((endTime + 1) / dt));

              for (let i = startIndex; i < endIndex; i++) {
                  const point = track.data[i];
                  if (point.n === null) {
                      isDrawing = false;
                      continue;
                  }
                  const x = ((point.t - startTime) / visibleDuration) * width;
                  const y = drawHeight - (point.n - minNote) * pxPerNote;

                  if (!isDrawing) {
                      ctx.moveTo(x, y);
                      isDrawing = true;
                  } else {
                      ctx.lineTo(x, y);
                  }
              }
              ctx.stroke();
          });

          if (liveRecordingRef.current.length > 0) {
              ctx.beginPath();
              ctx.lineWidth = 4;
              ctx.strokeStyle = '#ffffff'; 
              ctx.lineJoin = 'round';
              ctx.lineCap = 'round';
              ctx.shadowBlur = 8;
              ctx.shadowColor = '#ffffff';
              ctx.globalAlpha = 1.0;

              let isDrawing = false;
              // 二分查找优化
              let low = 0, high = liveRecordingRef.current.length - 1;
              let startIdx = 0;
              while (low <= high) {
                  const mid = Math.floor((low + high) / 2);
                  if (liveRecordingRef.current[mid].t < startTime) low = mid + 1;
                  else high = mid - 1;
              }
              startIdx = Math.max(0, low - 1);

              for (let i = startIdx; i < liveRecordingRef.current.length; i++) {
                  const point = liveRecordingRef.current[i];
                  if (point.t > endTime) break; 

                  if (point.n === null) {
                      isDrawing = false;
                      continue;
                  }

                  const x = ((point.t - startTime) / visibleDuration) * width;
                  const y = drawHeight - (point.n - minNote) * pxPerNote;

                  if (x >= -50 && x <= width + 50) {
                      if (!isDrawing) {
                          ctx.moveTo(x, y);
                          isDrawing = true;
                      } else {
                          ctx.lineTo(x, y);
                      }
                  } else {
                      isDrawing = false;
                  }
              }
              ctx.stroke();
          }

      } catch (err) {
          console.error("Draw tracks error:", err);
      } finally {
          ctx.restore(); 
      }

      // 时间轴最后画，且用 BOTTOM_PADDING 保证位置正确
      drawTimeAxis(ctx, width, height, startTime, endTime, false, BOTTOM_PADDING);
  };

  const updatePitch = () => {
    if (!analyserRef.current) return;
    const bufferLength = 2048;
    const buffer = new Float32Array(bufferLength);
    analyserRef.current.getFloatTimeDomainData(buffer);
    const { pitch: acPitch, clarity: currentClarity } = autoCorrelateAlgorithm(buffer, audioContextRef.current.sampleRate);
    setClarity(currentClarity); 

    let finalPitch = -1;
    let rawNoteNum = -1;

    // 平滑处理...
    if (acPitch === -1) {
      if (smoothingBufferRef.current.length > 0) {
          smoothingBufferRef.current.shift();
          smoothingBufferRef.current.shift(); 
      }
      if (smoothingBufferRef.current.length === 0) {
          finalPitch = -1;
          lastStablePitchRef.current = 0; 
      } else {
           const sorted = [...smoothingBufferRef.current].sort((a, b) => a - b);
           finalPitch = sorted[Math.floor(sorted.length / 2)];
      }
    } else {
      let processedPitch = acPitch;
      if (lastStablePitchRef.current > 0) {
          const ratio = processedPitch / lastStablePitchRef.current;
          if (ratio > 1.9 && ratio < 2.1) processedPitch /= 2;
          else if (ratio > 0.48 && ratio < 0.52) processedPitch *= 2;
      }
      smoothingBufferRef.current.push(processedPitch);
      if (smoothingBufferRef.current.length > 7) smoothingBufferRef.current.shift();
      const sorted = [...smoothingBufferRef.current].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      finalPitch = median;
      if (finalPitch > 0) {
          if (lastStablePitchRef.current === 0) lastStablePitchRef.current = finalPitch;
          else lastStablePitchRef.current = lastStablePitchRef.current * 0.9 + finalPitch * 0.1;
      }
    }

    if (acPitch === -1 && smoothingBufferRef.current.length < 3) finalPitch = -1;

    if (finalPitch > 0) {
      setFrequency(Math.round(finalPitch));
      rawNoteNum = 12 * (Math.log(finalPitch / 440) / Math.log(2)) + 69;
      
      if (importedTracks.length === 0) {
          pitchHistoryRef.current.push(rawNoteNum);
      }

      const roundedNote = Math.round(rawNoteNum);
      const noteName = NOTE_STRINGS[roundedNote % 12];
      const oct = Math.floor(roundedNote / 12) - 1;
      const targetFreq = 440 * Math.pow(2, (roundedNote - 69) / 12);
      const centsOff = Math.floor(1200 * Math.log2(finalPitch / targetFreq));
      setNote(noteName);
      setOctave(oct);
      setCents(centsOff);
    } else {
      if (importedTracks.length === 0) {
          pitchHistoryRef.current.push(null);
      }
    }

    // 录音逻辑
    if (importedTracks.length > 0 && isListeningRef.current) {
        const currentTime = audioContextRef.current.currentTime - recordingStartTimeRef.current;
        if (currentTime >= 0) {
            liveRecordingRef.current.push({ 
                t: currentTime, 
                n: finalPitch > 0 ? rawNoteNum : null 
            });
        }
    }

    if (importedTracks.length === 0) {
        const maxFrames = FIXED_TIME_WINDOW * 60;
        if (pitchHistoryRef.current.length > maxFrames) pitchHistoryRef.current.shift();
    }
    
    // 强制重绘
    if (importedTracks.length > 0) {
        requestAnimationFrame(drawFileGraph);
    } else {
        drawLiveGraph();
    }
    
    if (isListeningRef.current) rafIdRef.current = requestAnimationFrame(updatePitch);
  };

  const startListening = async () => {
    try {
      setError('');
      
      // 检查浏览器支持
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const errorMsg = "浏览器不支持音频输入，请使用现代浏览器（Chrome、Edge、Firefox等）";
        console.error(errorMsg);
        setError(errorMsg);
        return;
      }
      
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
          audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      } else if (audioContextRef.current.state === 'suspended') {
          await audioContextRef.current.resume();
      }

      // 如果有伴奏且不在播放，开始播放
      if (accompaniment && !accompanimentSourceRef.current) {
          const source = audioContextRef.current.createBufferSource();
          source.buffer = accompaniment.buffer;
          source.connect(audioContextRef.current.destination);
          source.start(0);
          accompanimentSourceRef.current = source;
          
          // 伴奏播放完回调（可选：停止录音？）
          source.onended = () => {
              // accompanimentSourceRef.current = null;
          };
      }

      // 构建音频约束，Windows 上需要更宽松的处理
      let constraints = {
          audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
          }
      };
      
      // 只有在明确选择了设备时才使用 exact 约束
      if (selectedDeviceId) {
          constraints.audio.deviceId = { exact: selectedDeviceId };
      } else {
          // 不指定设备，让系统选择默认设备
          constraints.audio.deviceId = undefined;
      }

      let stream;
      try {
          console.log("尝试获取音频流，约束条件:", constraints);
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          console.log("成功获取音频流:", stream);
      } catch (err) {
          console.warn("指定配置获取失败，错误详情:", err.name, err.message);
          
          // 如果是指定设备失败，尝试不指定设备
          if (selectedDeviceId && (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError')) {
              console.warn("指定设备不可用，尝试使用默认设备...");
              constraints.audio.deviceId = undefined;
              try {
                  stream = await navigator.mediaDevices.getUserMedia(constraints);
              } catch (err2) {
                  console.error("使用默认设备也失败:", err2);
                  throw err2;
              }
          } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
              throw new Error("麦克风权限被拒绝，请在浏览器设置中允许访问麦克风");
          } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
              throw new Error("未找到可用的麦克风设备，请检查设备连接");
          } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
              throw new Error("麦克风被其他应用占用，请关闭其他使用麦克风的程序");
          } else {
              // 最后尝试最简单的配置
              console.warn("尝试最简单的配置...");
              try {
                  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              } catch (err3) {
                  console.error("所有配置都失败:", err3);
                  throw err;
              }
          }
      }
      
      // 验证流是否有效
      if (!stream || !stream.getAudioTracks || stream.getAudioTracks().length === 0) {
          throw new Error("获取的音频流无效，没有音频轨道");
      }
      
      console.log("音频轨道信息:", stream.getAudioTracks().map(t => ({
          id: t.id,
          label: t.label,
          enabled: t.enabled,
          muted: t.muted,
          readyState: t.readyState
      })));
      
      // 更新设备列表（可能获取到新的设备标签）
      fetchAudioDevices();

      filterRef.current = audioContextRef.current.createBiquadFilter();
      filterRef.current.type = "lowpass";
      filterRef.current.frequency.value = 1000; 
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 2048;
      analyserRef.current.smoothingTimeConstant = 0.3;
      
      sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
      sourceRef.current.connect(filterRef.current);
      filterRef.current.connect(analyserRef.current);
      
      // 开始新录音时重置
      if (importedTracks.length > 0) {
          liveRecordingRef.current = [];
          recordingStartTimeRef.current = audioContextRef.current.currentTime;
      }

      setIsFullView(false); // 开始录音时强制切换到10s窗口模式
      setIsListening(true);
      isListeningRef.current = true;
      updatePitch();
    } catch (err) {
      console.error("启动监听失败:", err);
      const errorMsg = err.message || (typeof err === 'string' ? err : '无法访问麦克风。请确保已授予权限并检查设备连接。');
      setError(errorMsg);
      setIsListening(false);
      isListeningRef.current = false;
    }
  };

  const stopListening = () => {
    if (sourceRef.current) sourceRef.current.disconnect();
    if (filterRef.current) filterRef.current.disconnect();
    if (analyserRef.current) analyserRef.current.disconnect();
    if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    
    // 停止伴奏
    if (accompanimentSourceRef.current) {
        try {
            accompanimentSourceRef.current.stop();
        } catch(e) {}
        accompanimentSourceRef.current = null;
    }

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().then(() => {
            audioContextRef.current = null;
        });
    } else {
        audioContextRef.current = null;
    }
    
    analyserRef.current = null;

    setIsListening(false);
    isListeningRef.current = false;
    setNote('-');
    setOctave('');
    setFrequency(0);
    setCents(0);
    setClarity(0);
    smoothingBufferRef.current = []; 
    lastStablePitchRef.current = 0;
    
    // 停止后重绘一次，清理状态
    if (importedTracks.length === 0) {
        const canvas = canvasRef.current;
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#030712';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
    } else {
        requestAnimationFrame(drawFileGraph);
    }
  };

  return (
    <div 
      className="flex flex-col items-center min-h-screen w-full bg-gray-950 text-white font-sans overflow-hidden border border-gray-800/50"
      style={{ 
        paddingTop: 'calc(60px + env(safe-area-inset-top))', 
        paddingBottom: 'calc(24px + env(safe-area-inset-bottom))' 
      }}
    >
        <input 
            type="file" 
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
            accept="audio/*"
            multiple 
        />
        {/* 伴奏输入 */}
        <input 
            type="file" 
            ref={accompanimentInputRef}
            onChange={handleAccompanimentUpload}
            className="hidden"
            accept="audio/*"
        />

        {/* Top Header */}
        <div 
          className="w-full flex items-center justify-between px-6 py-3 bg-gray-900/60 backdrop-blur-md border-b border-gray-800/50 select-none shadow-sm"
          style={{ WebkitAppRegion: 'drag' }} 
        >
           <div className="flex items-center gap-4">
             <div className="w-12 h-12 relative flex items-center justify-center drop-shadow-[0_2px_8px_rgba(34,197,94,0.3)]">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" className="w-full h-full">
                  <defs>
                    <linearGradient id="c4-green-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" style={{stopColor:"#4ade80", stopOpacity:1}} />
                      <stop offset="100%" style={{stopColor:"#16a34a", stopOpacity:1}} />
                    </linearGradient>
                  </defs>
                  <text x="4" y="54" fontFamily="serif" fontWeight="900" fontSize="56" fill="url(#c4-green-gradient)" style={{ filter: 'drop-shadow(0px 2px 3px rgba(0,0,0,0.5))' }}>C</text>
                  <text x="40" y="26" fontFamily="serif" fontWeight="900" fontSize="34" fill="url(#c4-green-gradient)" style={{ filter: 'drop-shadow(0px 2px 3px rgba(0,0,0,0.5))' }}>4</text>
                </svg>
             </div>
             <div>
                <h1 className="text-xl font-bold tracking-wider text-gray-100">Pitch Tuner</h1>
                <p className="text-xs text-gray-400 font-medium tracking-wide">Professional Vocal Monitor</p>
             </div>
           </div>
           
           <div className="flex items-center gap-3" style={{ WebkitAppRegion: 'no-drag' }}>
              {/* 伴奏导入 */}
              <button
                onClick={() => accompanimentInputRef.current?.click()}
                disabled={isProcessing || isListening}
                className={`p-3.5 rounded-full text-gray-300 transition-all border border-gray-700 active:scale-95 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed ${isListening ? 'bg-gray-900 cursor-not-allowed opacity-30' : 'bg-gray-800 hover:bg-gray-700'}`}
                title="导入伴奏 (仅播放)"
              >
                 <Music size={22} className={accompaniment ? "text-green-400" : ""} />
              </button>

              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isProcessing || isListening} // 录音时禁止导入
                className={`p-3.5 rounded-full text-gray-300 transition-all border border-gray-700 active:scale-95 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed ${isListening ? 'bg-gray-900 cursor-not-allowed opacity-30' : 'bg-gray-800 hover:bg-gray-700'}`}
                title="导入音频"
              >
                {isProcessing ? <Loader2 size={22} className="animate-spin" /> : <FolderOpen size={22} />}
              </button>

              {/* 麦克风选择器 */}
              <div className="relative" ref={settingsRef}>
                 <button 
                    onClick={() => setShowSettings(!showSettings)}
                    className="p-3.5 rounded-full bg-gray-800 hover:bg-gray-700 text-gray-300 transition-all border border-gray-700 active:scale-95 flex items-center justify-center"
                    title="Audio Settings"
                 >
                    <Settings size={22} />
                 </button>
                 
                 {showSettings && (
                     <div className="absolute top-full right-0 mt-2 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden">
                        <div className="px-3 py-2 bg-gray-900/50 border-b border-gray-700 text-xs text-gray-400 font-medium">
                            INPUT DEVICE
                        </div>
                        <div className="max-h-60 overflow-y-auto py-1">
                            {audioDevices.length === 0 ? (
                                <div className="px-3 py-2 text-xs text-gray-500 italic">No devices found</div>
                            ) : (
                                audioDevices.map(device => (
                                    <button
                                        key={device.deviceId}
                                        onClick={() => handleDeviceChange(device.deviceId)}
                                        className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-gray-700 transition-colors ${selectedDeviceId === device.deviceId ? 'text-green-400' : 'text-gray-300'}`}
                                    >
                                        {selectedDeviceId === device.deviceId && <Check size={14} />}
                                        <span className="truncate">{device.label || `Microphone ${device.deviceId.slice(0, 5)}...`}</span>
                                    </button>
                                ))
                            )}
                        </div>
                     </div>
                 )}
              </div>

              <button
                onClick={isListening ? stopListening : startListening}
                className={`p-3.5 rounded-full transition-all shadow-lg active:scale-95 flex items-center justify-center border ${isListening ? 'bg-red-600 hover:bg-red-500 border-red-500/50 shadow-red-600/20' : 'bg-green-600 hover:bg-green-500 border-green-500/50 shadow-green-600/20'}`}
                title={isListening ? "停止" : "开始"}
              >
                {isListening ? <MicOff size={22} /> : <Mic size={22} />}
              </button>
           </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 w-full max-w-4xl flex flex-col items-center justify-center gap-10 p-6">
          
          <div className="flex flex-col items-center gap-3">
            <div className={`text-[8rem] sm:text-[10rem] leading-none font-black tracking-tighter transition-all duration-200 ${getTunerColor(cents)}`} style={{ textShadow: '0 4px 12px rgba(0,0,0,0.3)' }}>
              {note}<span className="text-5xl sm:text-6xl align-top ml-2 font-bold opacity-70 text-current" style={{ position: 'relative', top: '0.1em' }}>{octave}</span>
            </div>
            
            <div className="flex items-center gap-5 text-gray-400 font-mono bg-gray-900/40 px-6 py-2 rounded-full border border-gray-800/50 backdrop-blur-sm">
               <span className="text-xl font-semibold">{frequency > 0 ? `${frequency} Hz` : '-- Hz'}</span>
               {frequency > 0 && <span className="text-gray-700">|</span>}
               {frequency > 0 && (
                 <span className={`text-lg font-bold ${Math.abs(cents) < 5 ? 'text-green-400' : 'text-gray-400'}`}>
                   {cents > 0 ? `+${cents}` : cents} cents
                 </span>
               )}
            </div>
          </div>

          <div className="w-full max-w-lg px-4">
            <div className="relative h-3 bg-gray-900/80 rounded-full overflow-hidden border border-gray-800/50 shadow-inner">
              <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-gray-500/50 z-10 transform -translate-x-1/2"></div>
              <div className="absolute left-1/2 top-0 bottom-0 w-[8%] bg-green-500/20 -translate-x-1/2"></div>
              <div 
                className={`absolute top-0 bottom-0 w-1 h-3 transition-all duration-150 ease-out transform -translate-x-1/2 ${Math.abs(cents) < 5 ? 'bg-green-400 shadow-[0_0_12px_rgba(74,222,128,1)] scale-y-125' : 'bg-green-600'}`}
                style={{ left: `${getNeedlePosition(cents)}%` }}
              ></div>
            </div>
             <div className="flex justify-between text-[10px] text-gray-500 mt-2 px-1 font-medium tracking-widest uppercase">
              <span>Flat</span>
              <span className={Math.abs(cents) < 5 ? 'text-green-500 font-bold' : ''}>In Tune</span>
              <span>Sharp</span>
            </div>
          </div>

          {/* Pitch History Graph */}
          <div className="w-full h-80 bg-gray-900/40 rounded-2xl border border-gray-800/50 overflow-hidden relative shadow-xl backdrop-blur-md flex flex-col">
            {/* Graph Header */}
            <div className="w-full p-3 flex justify-between items-start z-10 border-b border-gray-800/30 bg-gray-950/20">
                 <div className="flex items-center gap-2">
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-800/50 shadow-sm bg-gray-900/50 backdrop-blur-md">
                        <TrendingUp size={14} className="text-green-400" />
                        <span className="text-xs text-gray-300 font-semibold tracking-wide">
                            {importedTracks.length > 0 ? (
                                isFullView ? 'Analysis (Full View)' : 'Recording (Follow Mode)'
                            ) : 'Live Monitor'}
                        </span>
                    </div>
                    
                    {/* Zoom/View Controls - 移到右侧 */}
                    {importedTracks.length > 0 && (
                        <div className="flex items-center gap-2 px-2 animate-in fade-in bg-gray-900/50 backdrop-blur-md px-2 py-1 rounded-lg border border-gray-800/50">
                            <button 
                                onClick={() => setIsFullView(!isFullView)}
                                disabled={isListening} 
                                className={`p-1.5 rounded-md transition-colors ${isListening ? 'opacity-30 cursor-not-allowed bg-gray-800' : (isFullView ? 'bg-blue-600/30 text-blue-400' : 'bg-gray-700/50 text-gray-400 hover:bg-gray-700')}`}
                                title={isListening ? "Recording in progress..." : (isFullView ? "Switch to Follow Mode" : "Switch to Full View")}
                            >
                                {isFullView ? <Minimize size={14} /> : <Maximize size={14} />}
                            </button>

                            {isFullView && (
                                <>
                                    <div className="w-px h-4 bg-gray-700 mx-1"></div>
                                    <ZoomOut size={14} className="text-gray-500" />
                                    <input 
                                        type="range" 
                                        min="1" max="50" step="1" 
                                        value={viewZoom} 
                                        onChange={(e) => setViewZoom(Number(e.target.value))}
                                        className="w-20 h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-green-500"
                                    />
                                    <ZoomIn size={14} className="text-gray-500" />
                                </>
                            )}
                        </div>
                    )}
                 </div>

                 <div className="flex flex-col gap-2 items-end">
                     {/* 伴奏状态 */}
                     {accompaniment && (
                         <div className="flex items-center gap-2 text-xs bg-gray-800/80 px-2 py-1 rounded border border-gray-700/50 animate-in slide-in-from-right-2 mb-1">
                             <Music size={12} className="text-green-400" />
                             <span className="text-gray-300 truncate max-w-[100px]">{accompaniment.name}</span>
                             <button onClick={clearAccompaniment} className="text-gray-500 hover:text-red-400">
                                 <X size={12} />
                             </button>
                         </div>
                     )}
                     
                     {/* 导入音轨列表 */}
                     {importedTracks.length > 0 && (
                         <div className="flex flex-col gap-2 max-h-20 overflow-y-auto pr-1">
                             {importedTracks.map((track) => (
                                 <div key={track.id} className="flex items-center gap-2 text-xs bg-gray-800/50 px-2 py-1 rounded border border-gray-700/50 animate-in slide-in-from-right-2 hover:bg-gray-700/50 transition-colors">
                                     <div className="relative group flex items-center">
                                        <div className="w-3 h-3 rounded-full shadow-sm ring-1 ring-white/10" style={{backgroundColor: track.color}}></div>
                                        <input 
                                            type="color" 
                                            value={track.color}
                                            onChange={(e) => updateTrackColor(track.id, e.target.value)}
                                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                            title="Change Color"
                                        />
                                     </div>
                                     <span className="text-gray-300 truncate max-w-[80px]" title={track.name}>{track.name}</span>
                                     <button onClick={() => removeTrack(track.id)} className="text-gray-500 hover:text-red-400 ml-auto">
                                         <X size={12} />
                                     </button>
                                 </div>
                             ))}
                             <button onClick={() => setImportedTracks([])} className="text-[10px] text-red-400 hover:underline self-end flex items-center gap-1 mt-1">
                                 <Trash2 size={10} /> Clear All
                             </button>
                         </div>
                     )}
                 </div>
            </div>
            
            <div className="flex-1 relative w-full" onWheel={handleWheel}>
                <canvas ref={canvasRef} width="800" height="230" className="w-full h-full block" />
                
                {importedTracks.length > 0 && isFullView && viewZoom > 1 && (
                    <div className="absolute bottom-2 left-4 right-4 h-2 bg-gray-800/50 rounded-full overflow-hidden flex items-center" style={{bottom: '45px'}}>
                        <input 
                            type="range" 
                            min="0" max="1" step="0.001" 
                            value={viewScroll} 
                            onChange={(e) => setViewScroll(Number(e.target.value))}
                            className="w-full h-full opacity-0 cursor-ew-resize absolute z-10"
                        />
                        <div 
                            className="h-full bg-gray-600/80 rounded-full relative transition-all duration-75"
                            style={{ 
                                width: `${(100 / viewZoom)}%`, 
                                left: `${viewScroll * (100 - (100 / viewZoom))}%` 
                            }}
                        ></div>
                    </div>
                )}

                {isListening && importedTracks.length === 0 && clarity < 0.8 && frequency > 0 && (
                    <div className="absolute bottom-4 right-4 flex items-center gap-2 px-3 py-2 bg-red-500/10 rounded-xl text-xs text-red-200 font-medium border border-red-500/20 backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 shadow-sm pointer-events-none" style={{bottom: '50px'}}>
                        <AlertCircle size={16} className="text-red-400" />
                        <span>Poor Signal</span>
                    </div>
                )}
            </div>
          </div>

          {error && (
            <div className="absolute bottom-24 bg-red-500/10 border border-red-500/20 text-red-200 px-6 py-3 rounded-xl text-sm backdrop-blur-md font-medium shadow-lg text-center max-w-sm animate-in fade-in slide-in-from-bottom-4">
              {error}
            </div>
          )}
        </div>
    </div>
  );
};

export default PitchTuner;