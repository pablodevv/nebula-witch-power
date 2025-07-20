const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { URL } = require('url');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const https = require('https');
const FormData = require('form-data');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 10000;

// URLs de destino
const MAIN_TARGET_URL = 'https://appnebula.co';
const READING_SUBDOMAIN_TARGET = 'https://reading.nebulahoroscope.com';

// Configurações para Modificação de Conteúdo
const USD_TO_BRL_RATE = 5.00;
const CONVERSION_PATTERN = /\$(\d+(\.\d{2})?)/g;

// Cache para melhorar performance
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// Variáveis para captura de texto (simplificadas)
let capturedBoldText = 'identificar seu arquétipo de bruxa';
let lastCaptureTime = Date.now();
let isCapturing = false;

// HTTPS Agent otimizado
const agent = new https.Agent({
    rejectUnauthorized
