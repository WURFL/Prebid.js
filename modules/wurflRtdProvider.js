import { submodule } from '../src/hook.js';
import { fetch, sendBeacon } from '../src/ajax.js';
import { loadExternalScript } from '../src/adloader.js';
import {
  mergeDeep,
  prefixLog,
} from '../src/utils.js';
import { MODULE_TYPE_RTD } from '../src/activities/modules.js';
import { getStorageManager } from '../src/storageManager.js';
import { getGlobal } from '../src/prebidGlobal.js';

// Constants
const REAL_TIME_MODULE = 'realTimeData';
const MODULE_NAME = 'wurfl';

// WURFL_JS_HOST is the host for the WURFL service endpoints
const WURFL_JS_HOST = 'https://prebid.wurflcloud.com';
// WURFL_JS_ENDPOINT_PATH is the path for the WURFL.js endpoint used to load WURFL data
const WURFL_JS_ENDPOINT_PATH = '/wurfl.js';
// STATS_HOST is the host for the WURFL stats endpoint
const STATS_HOST = 'https://stats.prebid.wurflcloud.com'
// STATS_ENDPOINT_PATH is the path for the stats endpoint used to send analytics data
const STATS_ENDPOINT_PATH = '/v2/prebid/stats';

// Storage keys for localStorage caching
const WURFL_RTD_STORAGE_KEY = 'wurflrtd';

// OpenRTB 2.0 device type constants
// Based on OpenRTB 2.6 specification
const ORTB2_DEVICE_TYPE = {
  MOBILE_OR_TABLET: 1,
  PERSONAL_COMPUTER: 2,
  CONNECTED_TV: 3,
  PHONE: 4,
  TABLET: 5,
  CONNECTED_DEVICE: 6,
  SET_TOP_BOX: 7,
  OOH_DEVICE: 8
};

// OpenRTB 2.0 device fields that can be enriched from WURFL data
const ORTB2_DEVICE_FIELDS = [
  'make', 'model', 'devicetype', 'os', 'osv', 'hwv',
  'h', 'w', 'ppi', 'pxratio', 'js'
];

// Enrichment type constants
const ENRICHMENT_TYPE = {
  NONE: 'none',
  LCE: 'lce',
  WURFL_PUB: 'wurfl_pub',
  WURFL_SSP: 'wurfl_ssp',
  WURFL_PUB_SSP: 'wurfl_pub_ssp'
};

// Consent class constants
const CONSENT_CLASS = {
  NO: 0,        // No consent/opt-out/COPPA
  PARTIAL: 1,   // Partial or ambiguous
  FULL: 2       // Full consent or non-GDPR region
};

const logger = prefixLog('[WURFL RTD Submodule]');

// Storage manager for WURFL RTD provider
export const storage = getStorageManager({
  moduleType: MODULE_TYPE_RTD,
  moduleName: MODULE_NAME,
});

// enrichedBidders holds a list of prebid bidder names, of bidders which have been
// injected with WURFL data
const enrichedBidders = new Set();

// enrichmentType tracks the overall enrichment type used in the current auction
let enrichmentType = ENRICHMENT_TYPE.NONE;

// wurflId stores the WURFL ID from device data
let wurflId = '';

// WurflDebugger object for performance tracking and debugging
const WurflDebugger = {
  // Private timing start values
  _moduleExecutionStart: null,
  _cacheReadStart: null,
  _lceDetectionStart: null,
  _cacheWriteStart: null,
  _wurflJsLoadStart: null,

  // Initialize WURFL debug tracking
  init(isDebug) {
    if (!isDebug) {
      // Replace all methods (except init) with no-ops for zero overhead
      Object.keys(this).forEach(key => {
        if (typeof this[key] === 'function' && key !== 'init') {
          this[key] = () => { };
        }
      });
      return;
    }

    // Full debug mode - create/reset window object for tracking
    if (typeof window !== 'undefined') {
      window.WurflRtdDebug = {
        // Data source for current auction
        dataSource: 'unknown', // 'cache' | 'lce'

        // Cache state
        cacheExpired: false,    // Whether the cache was expired when used

        // Simple timing measurements
        moduleExecutionTime: null, // Total time from getBidRequestData start to callback
        cacheReadTime: null,    // Single cache read time (hit or miss)
        lceDetectionTime: null, // LCE detection time (only if dataSource = 'lce')
        cacheWriteTime: null,   // Async cache write time (for future auctions)
        wurflJsLoadTime: null,  // Total time from WURFL.js load start to cache complete

        // The actual data used in current auction
        data: {
          // When dataSource = 'cache'
          wurflData: null,      // The cached WURFL device data
          pbjsData: null,       // The cached wurfl_pbjs data

          // When dataSource = 'lce'
          lceDevice: null       // The LCE-generated device object
        },

        // Beacon payload sent to analytics endpoint
        beaconPayload: null
      };
    }
  },

  // Module execution timing methods
  moduleExecutionStart() {
    this._moduleExecutionStart = performance.now();
  },

  moduleExecutionStop() {
    if (this._moduleExecutionStart === null) return;
    const duration = performance.now() - this._moduleExecutionStart;
    window.WurflRtdDebug.moduleExecutionTime = duration;
    this._moduleExecutionStart = null;
  },

  // Cache read timing methods
  cacheReadStart() {
    this._cacheReadStart = performance.now();
  },

  cacheReadStop() {
    if (this._cacheReadStart === null) return;
    const duration = performance.now() - this._cacheReadStart;
    window.WurflRtdDebug.cacheReadTime = duration;
    this._cacheReadStart = null;
  },

  // LCE detection timing methods
  lceDetectionStart() {
    this._lceDetectionStart = performance.now();
  },

  lceDetectionStop() {
    if (this._lceDetectionStart === null) return;
    const duration = performance.now() - this._lceDetectionStart;
    window.WurflRtdDebug.lceDetectionTime = duration;
    this._lceDetectionStart = null;
  },

  // Cache write timing methods
  cacheWriteStart() {
    this._cacheWriteStart = performance.now();
  },

  cacheWriteStop() {
    if (this._cacheWriteStart === null) return;
    const duration = performance.now() - this._cacheWriteStart;
    window.WurflRtdDebug.cacheWriteTime = duration;
    this._cacheWriteStart = null;

    // Calculate total WURFL.js load time (from load start to cache complete)
    if (this._wurflJsLoadStart !== null) {
      const totalLoadTime = performance.now() - this._wurflJsLoadStart;
      window.WurflRtdDebug.wurflJsLoadTime = totalLoadTime;
      this._wurflJsLoadStart = null;
    }

    // Dispatch custom event when cache write data is available
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      const event = new CustomEvent('wurflCacheWriteComplete', {
        detail: {
          duration: duration,
          timestamp: Date.now(),
          debugData: window.WurflRtdDebug
        }
      });
      window.dispatchEvent(event);
    }
  },

  // WURFL.js load timing methods
  wurflJsLoadStart() {
    this._wurflJsLoadStart = performance.now();
  },

  // Data tracking methods
  setDataSource(source) {
    window.WurflRtdDebug.dataSource = source;
  },

  setCacheData(wurflData, pbjsData) {
    window.WurflRtdDebug.data.wurflData = wurflData;
    window.WurflRtdDebug.data.pbjsData = pbjsData;
  },

  setLceData(lceDevice) {
    window.WurflRtdDebug.data.lceDevice = lceDevice;
  },

  setCacheExpired(expired) {
    window.WurflRtdDebug.cacheExpired = expired;
  },

  setBeaconPayload(payload) {
    window.WurflRtdDebug.beaconPayload = payload;
  }
};

/**
 * Safely gets an object from localStorage with JSON parsing
 * @param {string} key The storage key
 * @returns {Object|null} Parsed object or null if not found/invalid
 */
function getObjectFromStorage(key) {
  if (!storage.hasLocalStorage() || !storage.localStorageIsEnabled()) {
    return null;
  }

  try {
    const dataStr = storage.getDataFromLocalStorage(key);
    return dataStr ? JSON.parse(dataStr) : null;
  } catch (e) {
    logger.logError(`Error parsing stored data for key ${key}:`, e);
    return null;
  }
}

/**
 * Safely sets an object to localStorage with JSON stringification
 * @param {string} key The storage key
 * @param {Object} data The data to store
 * @returns {boolean} Success status
 */
function setObjectToStorage(key, data) {
  if (!storage.hasLocalStorage() || !storage.localStorageIsEnabled()) {
    return false;
  }

  try {
    storage.setDataInLocalStorage(key, JSON.stringify(data));
    return true;
  } catch (e) {
    logger.logError(`Error storing data for key ${key}:`, e);
    return false;
  }
}

/**
 * enrichDeviceFPD enriches the global device object with device data
 * @param {Object} reqBidsConfigObj Bid request configuration object
 * @param {Object} deviceData Device data to enrich with
 */
function enrichDeviceFPD(reqBidsConfigObj, deviceData) {
  if (!deviceData || !reqBidsConfigObj?.ortb2Fragments?.global) {
    return;
  }

  const prebidDevice = reqBidsConfigObj.ortb2Fragments.global.device || {};
  const enrichedDevice = {};

  ORTB2_DEVICE_FIELDS.forEach(field => {
    // Check if field already exists in prebid device
    if (prebidDevice[field] !== undefined) {
      return;
    }

    // Check if deviceData has a valid value for this field
    if (deviceData[field] === undefined) {
      return;
    }

    // Copy the field value from deviceData to enrichedDevice
    enrichedDevice[field] = deviceData[field];
  });

  // Use mergeDeep to properly merge into global device
  mergeDeep(reqBidsConfigObj.ortb2Fragments.global, { device: enrichedDevice });
}

/**
 * enrichDeviceBidder enriches bidder-specific device data with WURFL data
 * @param {Object} reqBidsConfigObj Bid request configuration object
 * @param {Set} bidders Set of bidder codes
 * @param {WurflJSDevice} wjsDevice WURFL.js device data with permissions and caps
 */
function enrichDeviceBidder(reqBidsConfigObj, bidders, wjsDevice) {
  bidders.forEach((bidderCode) => {
    // Get bidder data (handles both authorized and unauthorized bidders)
    const bidderDevice = wjsDevice.Bidder(bidderCode);

    // Skip if no data to inject (over quota + unauthorized)
    if (Object.keys(bidderDevice).length === 0) {
      return;
    }

    // Track only authorized bidders for analytics
    if (wjsDevice._isAuthorized(bidderCode)) {
      enrichedBidders.add(bidderCode);
    }

    // Inject WURFL data
    mergeDeep(reqBidsConfigObj.ortb2Fragments.bidder, { [bidderCode]: bidderDevice });
  });
}

/**
 * loadWurflJsAsync loads WURFL.js asynchronously and stores response to localStorage
 * @param {Object} config Configuration for WURFL RTD submodule
 * @param {Set} bidders Set of bidder codes
 */
function loadWurflJsAsync(config, bidders) {
  const altHost = config.params?.altHost ?? null;
  const isDebug = config.params?.debug ?? false;

  let host = WURFL_JS_HOST;
  if (altHost) {
    host = altHost;
  }

  const url = new URL(host);
  url.pathname = WURFL_JS_ENDPOINT_PATH;

  // Start timing WURFL.js load
  WurflDebugger.wurflJsLoadStart();

  if (isDebug) {
    url.searchParams.set('debug', 'true');
  }

  url.searchParams.set('mode', 'prebid2');

  // Add bidders list for server optimization
  if (bidders && bidders.size > 0) {
    url.searchParams.set('bidders', Array.from(bidders).join(','));
  }

  // Helper function to load WURFL.js script
  const loadWurflJs = (scriptUrl) => {
    try {
      loadExternalScript(scriptUrl, MODULE_TYPE_RTD, MODULE_NAME, () => {
        logger.logMessage('async WURFL.js script injected');
        window.WURFLPromises.complete.then((res) => {
          logger.logMessage('async WURFL.js data received', res);
          if (res.wurfl_pbjs) {
            // Create optimized cache object with only relevant device data
            WurflDebugger.cacheWriteStart();
            const cacheData = {
              WURFL: res.WURFL,
              wurfl_pbjs: res.wurfl_pbjs,
              expire_at: Date.now() + (res.wurfl_pbjs.ttl * 1000)
            };
            setObjectToStorage(WURFL_RTD_STORAGE_KEY, cacheData);
            WurflDebugger.cacheWriteStop();
            logger.logMessage('WURFL.js device cache stored to localStorage');
          } else {
            logger.logError('invalid async WURFL.js for Prebid response');
          }
        }).catch((err) => {
          logger.logError('async WURFL.js promise error:', err);
        });
      });
    } catch (err) {
      logger.logError('async WURFL.js loading error:', err);
    }
  };

  // Collect Client Hints if available, then load script
  if (navigator?.userAgentData?.getHighEntropyValues) {
    const hints = ['architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion', 'fullVersionList'];
    navigator.userAgentData.getHighEntropyValues(hints)
      .then(ch => {
        if (ch !== null) {
          url.searchParams.set('uach', JSON.stringify(ch));
        }
      })
      .finally(() => {
        loadWurflJs(url.toString());
      });
  } else {
    // Load script immediately when Client Hints not available
    loadWurflJs(url.toString());
  }
}

/**
 * init initializes the WURFL RTD submodule
 * @param {Object} config Configuration for WURFL RTD submodule
 * @param {Object} userConsent User consent data
 */
const init = (config, userConsent) => {
  // Initialize debugger based on debug flag
  const isDebug = config?.params?.debug ?? false;
  WurflDebugger.init(isDebug);

  // A/B testing: early return if not enabled
  const abTest = config?.params?.abTest ?? false;
  if (!abTest) {
    logger.logMessage('initialized');
    return true;
  }

  // A/B testing enabled - determine treatment vs control
  const abName = config?.params?.abName ?? 'unknown';
  const abSplit = config?.params?.abSplit ?? 50;

  const randomValue = Math.floor(Math.random() * 100);
  const isInTreatment = randomValue < abSplit;

  if (isInTreatment) {
    logger.logMessage(`A/B test "${abName}": user in treatment group (enabled)`);
    return true;
  }

  // User is in control group - disable module
  logger.logMessage(`A/B test "${abName}": user in control group (disabled)`);
  return false;
}

/**
 * getBidRequestData enriches the OpenRTB 2.0 device data with WURFL data
 * @param {Object} reqBidsConfigObj Bid request configuration object
 * @param {Function} callback Called on completion
 * @param {Object} config Configuration for WURFL RTD submodule
 * @param {Object} userConsent User consent data
 */
const getBidRequestData = (reqBidsConfigObj, callback, config, userConsent) => {
  // Start module execution timing
  WurflDebugger.moduleExecutionStart();

  // Extract bidders from request configuration
  const bidders = new Set();
  reqBidsConfigObj.adUnits.forEach(adUnit => {
    adUnit.bids.forEach(bid => {
      bidders.add(bid.bidder);
    });
  });

  // Priority 1: Check if WURFL.js response is cached
  WurflDebugger.cacheReadStart();
  const cachedWurflData = getObjectFromStorage(WURFL_RTD_STORAGE_KEY);
  WurflDebugger.cacheReadStop();

  if (cachedWurflData) {
    const isExpired = cachedWurflData.expire_at && Date.now() > cachedWurflData.expire_at;

    WurflDebugger.setDataSource('cache');
    WurflDebugger.setCacheExpired(isExpired);
    WurflDebugger.setCacheData(cachedWurflData.WURFL, cachedWurflData.wurfl_pbjs);

    logger.logMessage(isExpired ? 'using expired cached WURFL.js data' : 'using cached WURFL.js data');

    const wjsDevice = WurflJSDevice.fromCache(cachedWurflData);
    if (!wjsDevice._isOverQuota()) {
      enrichDeviceFPD(reqBidsConfigObj, wjsDevice.FPD());
    }
    enrichDeviceBidder(reqBidsConfigObj, bidders, wjsDevice);

    // Set enrichment type to WURFL publisher caps
    enrichmentType = ENRICHMENT_TYPE.WURFL_PUB;

    // Store WURFL ID for analytics
    wurflId = cachedWurflData.WURFL?.wurfl_id || '';

    // If expired, refresh cache async
    if (isExpired) {
      loadWurflJsAsync(config, bidders);
    }

    WurflDebugger.moduleExecutionStop();
    callback();
    return;
  }

  // Priority 2: return LCE data
  logger.logMessage('generating fresh LCE data');
  WurflDebugger.setDataSource('lce');
  WurflDebugger.lceDetectionStart();
  const fpdDevice = WurflLCEDevice.FPD();
  WurflDebugger.lceDetectionStop();
  WurflDebugger.setLceData(fpdDevice);
  enrichDeviceFPD(reqBidsConfigObj, fpdDevice);

  // Set enrichment type to LCE
  enrichmentType = ENRICHMENT_TYPE.LCE;

  // Load WURFL.js async for future requests
  loadWurflJsAsync(config, bidders);

  WurflDebugger.moduleExecutionStop();
  callback();
}

/**
 * getConsentClass calculates the consent classification level
 * @param {Object} userConsent User consent data
 * @returns {number} Consent class (0, 1, or 2)
 */
function getConsentClass(userConsent) {
  // Default to no consent if userConsent is not provided or is an empty object
  if (!userConsent || Object.keys(userConsent).length === 0) {
    return CONSENT_CLASS.NO;
  }

  // Check COPPA (Children's Privacy)
  if (userConsent.coppa === true) {
    return CONSENT_CLASS.NO;
  }

  // Check USP/CCPA (US Privacy)
  if (userConsent.usp && typeof userConsent.usp === 'string') {
    if (userConsent.usp.substring(0, 2) === '1Y') {
      return CONSENT_CLASS.NO;
    }
  }


  // Check GDPR object exists
  if (!userConsent.gdpr) {
    return CONSENT_CLASS.FULL; // No GDPR data means not applicable
  }

  // Check GDPR applicability - Note: might be in vendorData
  const gdprApplies = userConsent.gdpr.gdprApplies === true || userConsent.gdpr.vendorData?.gdprApplies === true;

  if (!gdprApplies) {
    return CONSENT_CLASS.FULL;
  }

  // GDPR applies - evaluate purposes
  const vendorData = userConsent.gdpr.vendorData;

  if (!vendorData || !vendorData.purpose) {
    return CONSENT_CLASS.NO;
  }

  const purposes = vendorData.purpose;
  const consents = purposes.consents || {};
  const legitimateInterests = purposes.legitimateInterests || {};

  // Count allowed purposes (7, 8, 10)
  let allowedCount = 0;

  // Purpose 7: Measure ad performance
  if (consents['7'] === true || legitimateInterests['7'] === true) {
    allowedCount++;
  }

  // Purpose 8: Market research
  if (consents['8'] === true || legitimateInterests['8'] === true) {
    allowedCount++;
  }

  // Purpose 10: Develop/improve products
  if (consents['10'] === true || legitimateInterests['10'] === true) {
    allowedCount++;
  }

  // Classify based on allowed purposes count
  if (allowedCount === 0) {
    return CONSENT_CLASS.NO;
  }
  if (allowedCount === 3) {
    return CONSENT_CLASS.FULL;
  }
  return CONSENT_CLASS.PARTIAL;
}

/**
 * onAuctionEndEvent is called when the auction ends
 * @param {Object} auctionDetails Auction details
 * @param {Object} config Configuration for WURFL RTD submodule
 * @param {Object} userConsent User consent data
 */
function onAuctionEndEvent(auctionDetails, config, userConsent) {

  const statsHost = config.params?.statsHost ?? null;

  let host = STATS_HOST;
  if (statsHost) {
    host = statsHost;
  }

  const url = new URL(host);
  url.pathname = STATS_ENDPOINT_PATH;

  // Only send beacon if there are bids to report
  if (!auctionDetails.bidsReceived || auctionDetails.bidsReceived.length === 0) {
    return;
  }

  logger.logMessage(`onAuctionEndEvent: processing ${auctionDetails.bidsReceived.length} bid responses`);

  // Build a lookup object for winning bid request IDs
  const winningBids = getGlobal().getHighestCpmBids() || [];
  const winningBidIds = {};
  for (let i = 0; i < winningBids.length; i++) {
    const bid = winningBids[i];
    winningBidIds[bid.requestId] = true;
  }

  logger.logMessage(`onAuctionEndEvent: ${winningBids.length} winning bids identified`);

  // Build a lookup object for bid responses: "adUnitCode:bidderCode" -> bid
  const bidResponseMap = {};
  for (let i = 0; i < auctionDetails.bidsReceived.length; i++) {
    const bid = auctionDetails.bidsReceived[i];
    const adUnitCode = bid.adUnitCode;
    const bidderCode = bid.bidderCode || bid.bidder;
    const key = adUnitCode + ':' + bidderCode;
    bidResponseMap[key] = bid;
  }

  // Build ad units array with all bidders (including non-responders)
  const adUnits = [];

  if (auctionDetails.adUnits) {
    for (let i = 0; i < auctionDetails.adUnits.length; i++) {
      const adUnit = auctionDetails.adUnits[i];
      const adUnitCode = adUnit.code;
      const bidders = [];

      // Check each bidder configured for this ad unit
      for (let j = 0; j < adUnit.bids.length; j++) {
        const bidConfig = adUnit.bids[j];
        const bidderCode = bidConfig.bidder;
        const key = adUnitCode + ':' + bidderCode;
        const bidResponse = bidResponseMap[key];

        if (bidResponse) {
          // Bidder responded - include full data
          const isWinner = winningBidIds[bidResponse.requestId] === true;
          bidders.push({
            bidder: bidderCode,
            enrichment: enrichmentType,
            cpm: bidResponse.cpm,
            currency: bidResponse.currency,
            won: isWinner
          });
        } else {
          // Bidder didn't respond - include without cpm/currency
          bidders.push({
            bidder: bidderCode,
            enrichment: enrichmentType,
            won: false
          });
        }
      }

      adUnits.push({
        ad_unit_code: adUnitCode,
        bidders: bidders
      });
    }
  }

  // Count bidders for logging
  let totalBidderEntries = 0;
  for (let i = 0; i < adUnits.length; i++) {
    totalBidderEntries += adUnits[i].bidders.length;
  }
  const respondedBidders = auctionDetails.bidsReceived.length;
  const nonRespondingBidders = totalBidderEntries - respondedBidders;

  logger.logMessage(`onAuctionEndEvent: built ${adUnits.length} ad units with ${totalBidderEntries} total bidder entries (${respondedBidders} responded, ${nonRespondingBidders} non-responding)`);

  // Calculate consent class
  const consentClass = getConsentClass(userConsent);

  // Build complete payload
  const payload = JSON.stringify({
    domain: typeof window !== 'undefined' ? window.location.hostname : '',
    path: typeof window !== 'undefined' ? window.location.pathname : '',
    sampling_rate: config.params?.samplingRate || 100,
    enrichment: enrichmentType,
    wurfl_id: wurflId,
    consent_class: consentClass,
    ad_units: adUnits
  });

  const sentBeacon = sendBeacon(url.toString(), payload);
  if (sentBeacon) {
    WurflDebugger.setBeaconPayload(JSON.parse(payload));
    return;
  }

  fetch(url.toString(), {
    method: 'POST',
    body: payload,
    mode: 'no-cors',
    keepalive: true
  });

  WurflDebugger.setBeaconPayload(JSON.parse(payload));
}

// The WURFL submodule
export const wurflSubmodule = {
  name: MODULE_NAME,
  init,
  getBidRequestData,
  onAuctionEndEvent,
}

// Register the WURFL submodule as submodule of realTimeData
submodule(REAL_TIME_MODULE, wurflSubmodule);

// ==================== WURFL JS DEVICE MODULE ====================
const WurflJSDevice = {
  // Private properties
  _wurflData: null,       // WURFL data containing capability values (from window.WURFL)
  _pbjsData: null,        // wurfl_pbjs data with caps array and permissions (from response)
  _basicCaps: null,       // Cached basic capabilities (computed once)
  _pubCaps: null,         // Cached publisher capabilities (computed once)
  _device: null,          // Cached device object (computed once)

  // Constructor from WURFL.js local cache
  fromCache(res) {
    this._wurflData = res.WURFL || {};
    this._pbjsData = res.wurfl_pbjs || {};
    this._basicCaps = null;
    this._pubCaps = null;
    this._device = null;
    return this;
  },

  // Private method - converts a given value to a number
  _toNumber(value) {
    if (value === '' || value === null) {
      return undefined;
    }
    const num = Number(value);
    return Number.isNaN(num) ? undefined : num;
  },

  // Private method - filters capabilities based on indices
  _filterCaps(indexes) {
    const data = {};
    const caps = this._pbjsData.caps;          // Array of capability names
    const wurflData = this._wurflData;         // WURFL data containing capability values

    if (!indexes || !caps || !wurflData) {
      return data;
    }

    indexes.forEach((index) => {
      const capName = caps[index];  // Get capability name by index
      if (capName && capName in wurflData) {
        data[capName] = wurflData[capName];  // Get value from WURFL data
      }
    });

    return data;
  },

  // Private method - gets basic capabilities
  _getBasicCaps() {
    if (this._basicCaps !== null) {
      return this._basicCaps;
    }
    const basicCaps = this._pbjsData.global?.basic_set?.cap_indices || [];
    this._basicCaps = this._filterCaps(basicCaps);
    return this._basicCaps;
  },

  // Private method - gets publisher capabilities
  _getPubCaps() {
    if (this._pubCaps !== null) {
      return this._pubCaps;
    }
    const pubCaps = this._pbjsData.global?.publisher?.cap_indices || [];
    this._pubCaps = this._filterCaps(pubCaps);
    return this._pubCaps;
  },

  // Private method - gets bidder-specific capabilities
  _getBidderCaps(bidderCode) {
    const bidderCaps = this._pbjsData.bidders?.[bidderCode]?.cap_indices || [];
    return this._filterCaps(bidderCaps);
  },

  // Private method - checks if bidder is authorized
  _isAuthorized(bidderCode) {
    return !!(this._pbjsData.bidders && bidderCode in this._pbjsData.bidders);
  },

  // Private method - checks if over quota
  _isOverQuota() {
    return this._pbjsData.over_quota === 1;
  },

  // Private method - returns the ortb2 device type based on WURFL data
  _makeOrtb2DeviceType(wurflData) {
    if (('is_ott' in wurflData) && (wurflData.is_ott)) {
      return ORTB2_DEVICE_TYPE.SET_TOP_BOX;
    }
    if (('is_console' in wurflData) && (wurflData.is_console)) {
      return ORTB2_DEVICE_TYPE.CONNECTED_DEVICE;
    }
    if (('physical_form_factor' in wurflData) && (wurflData.physical_form_factor === 'out_of_home_device')) {
      return ORTB2_DEVICE_TYPE.OOH_DEVICE;
    }
    if (!('form_factor' in wurflData)) {
      return undefined;
    }
    switch (wurflData.form_factor) {
      case 'Desktop':
        return ORTB2_DEVICE_TYPE.PERSONAL_COMPUTER;
      case 'Smartphone':
        return ORTB2_DEVICE_TYPE.PHONE;
      case 'Feature Phone':
        return ORTB2_DEVICE_TYPE.PHONE;
      case 'Tablet':
        return ORTB2_DEVICE_TYPE.TABLET;
      case 'Smart-TV':
        return ORTB2_DEVICE_TYPE.CONNECTED_TV;
      case 'Other Non-Mobile':
        return ORTB2_DEVICE_TYPE.CONNECTED_DEVICE;
      case 'Other Mobile':
        return ORTB2_DEVICE_TYPE.MOBILE_OR_TABLET;
      default:
        return undefined;
    }
  },

  // Public API - returns device object for First Party Data (global)
  FPD() {
    if (this._device !== null) {
      return this._device;
    }

    const wd = this._wurflData;
    if (!wd) {
      this._device = {};
      return this._device;
    }

    this._device = {
      make: wd.brand_name,
      model: wd.model_name,
      devicetype: this._makeOrtb2DeviceType(wd),
      os: wd.advertised_device_os,
      osv: wd.advertised_device_os_version,
      hwv: wd.model_name,
      h: wd.resolution_height,
      w: wd.resolution_width,
      ppi: wd.pixel_density,
      pxratio: this._toNumber(wd.density_class),
      js: this._toNumber(wd.ajax_support_javascript)
    };
    return this._device;
  },

  // Public API - returns device with bidder-specific ext data
  Bidder(bidderCode) {
    const isAuthorized = this._isAuthorized(bidderCode);
    const isOverQuota = this._isOverQuota();

    // When unauthorized and over quota, return empty
    if (!isAuthorized && isOverQuota) {
      return {};
    }

    // Start with empty device, populate only if publisher is over quota
    // When over quota, we send device data to each authorized bidder individually
    let fpdDevice = {};
    if (isOverQuota) {
      fpdDevice = this.FPD();
    }

    if (!this._pbjsData.caps) {
      return { device: fpdDevice };
    }

    // For authorized bidders: basic + pub + bidder-specific caps
    // For unauthorized bidders (under quota only): basic + pub caps (no bidder-specific)
    const wurflData = {
      ...this._getBasicCaps(),
      ...this._getPubCaps(),
      ...(isAuthorized ? this._getBidderCaps(bidderCode) : {})
    };

    return {
      device: {
        ...fpdDevice,
        ext: {
          wurfl: wurflData
        }
      }
    };
  }
};
// ==================== END WURFL JS DEVICE MODULE ====================

// ==================== WURFL LCE DEVICE MODULE ====================
const WurflLCEDevice = {
  // Private mappings for device detection
  _desktopMapping: new Map([
    ["Windows NT", "Windows"],
    ["Macintosh; Intel Mac OS X", "macOS"],
    ["Mozilla/5.0 (X11; Linux", "Linux"],
    ["X11; Ubuntu; Linux x86_64", "Linux"],
    ["Mozilla/5.0 (X11; CrOS", "ChromeOS"],
  ]),

  _tabletMapping: new Map([
    ["iPad; CPU OS ", "iPadOS"],
  ]),

  _smartphoneMapping: new Map([
    ["Android", "Android"],
    ["iPhone; CPU iPhone OS", "iOS"],
  ]),

  _smarttvMapping: new Map([
    ["Web0S", "LG webOS"],
    ["SMART-TV; Linux; Tizen", "Tizen"],
  ]),

  _ottMapping: new Map([
    ["Roku", "Roku OS"],
    ["Xbox", "Windows"],
    ["PLAYSTATION", "PlayStation OS"],
    ["PlayStation", "PlayStation OS"],
  ]),

  _makeMapping: new Map([
    ["motorola", "Motorola"],
    [" moto ", "Motorola"],
    ["Android", "Generic"],
    ["iPad", "Apple"],
    ["iPhone", "Apple"],
    ["Firefox", "Mozilla"],
    ["Edge", "Microsoft"],
    ["Chrome", "Google"],
  ]),

  _modelMapping: new Map([
    ["Android", "Android"],
    ["iPad", "iPad"],
    ["iPhone", "iPhone"],
    ["Firefox", "Firefox"],
    ["Edge", "Edge"],
    ["Chrome", "Chrome"],
  ]),

  // Private helper methods
  _parseOsVersion(ua, osName) {
    let osv = "";
    switch (osName) {
      case "Windows": {
        const matches = ua.match(/Windows NT ([\d.]+)/);
        if (matches) {
          return matches[1];
        }
        return "";
      }
      case "macOS": {
        const matches = ua.match(/Mac OS X ([\d_]+)/);
        if (matches) {
          osv = matches[1].replaceAll('_', '.');
          return osv;
        }
        return "";
      }
      case "iOS": {
        const matches = ua.match(/iPhone; CPU iPhone OS ([\d_]+) like Mac OS X/);
        if (matches) {
          osv = matches[1].replaceAll('_', '.');
          return osv;
        }
        return "";
      }
      case "iPadOS": {
        const matches = ua.match(/iPad; CPU OS ([\d_]+) like Mac OS X/);
        if (matches) {
          osv = matches[1].replaceAll('_', '.');
          return osv;
        }
        return "";
      }
      case "Android": {
        // For Android UAs with a decimal
        const matches1 = ua.match(/Android ([\d.]+)/);
        // For Android UAs without a decimal
        const matches2 = ua.match(/Android ([\d]+)/);
        if (matches1) {
          return matches1[1];
        }
        if (matches2) {
          return matches2[1];
        }
        return "";
      }
      case "ChromeOS": {
        const matches = ua.match(/CrOS x86_64 ([\d.]+)/);
        if (matches) {
          return matches[1];
        }
        return "";
      }
      case "Tizen": {
        const matches = ua.match(/Tizen ([\d.]+)/);
        if (matches) {
          return matches[1];
        }
        return "";
      }
      case "Roku OS": {
        const matches = ua.match(/Roku\/DVP [\dA-Z]+ [\d.]+\/([\d.]+)/);
        if (matches) {
          return matches[1];
        }
        return "";
      }
      case "PlayStation OS": {
        // PS4
        const matches1 = ua.match(/PlayStation \d\/([\d.]+)/);
        // PS3
        const matches2 = ua.match(/PLAYSTATION \d ([\d.]+)/);
        if (matches1) {
          return matches1[1];
        }
        if (matches2) {
          return matches2[1];
        }
        return "";
      }
      case "Linux":
      case "LG webOS":
      default:
        return "";
    }
  },

  _makeDeviceInfo(deviceType, osName, ua) {
    return { deviceType, osName, osVersion: this._parseOsVersion(ua, osName) };
  },

  _getDeviceInfo(ua) {
    // Iterate over ottMapping
    // Should remove above Desktop
    for (const [osToken, osName] of this._ottMapping) {
      if (ua.includes(osToken)) {
        return this._makeDeviceInfo(ORTB2_DEVICE_TYPE.SET_TOP_BOX, osName, ua);
      }
    }
    // Iterate over desktopMapping
    for (const [osToken, osName] of this._desktopMapping) {
      if (ua.includes(osToken)) {
        return this._makeDeviceInfo(ORTB2_DEVICE_TYPE.PERSONAL_COMPUTER, osName, ua);
      }
    }
    // Iterate over tabletMapping
    for (const [osToken, osName] of this._tabletMapping) {
      if (ua.includes(osToken)) {
        return this._makeDeviceInfo(ORTB2_DEVICE_TYPE.TABLET, osName, ua);
      }
    }
    // Android Tablets
    if (ua.includes("Android") && !ua.includes("Mobile Safari") && ua.includes("Safari")) {
      return this._makeDeviceInfo(ORTB2_DEVICE_TYPE.TABLET, 'Android', ua);
    }
    // Iterate over smartphoneMapping
    for (const [osToken, osName] of this._smartphoneMapping) {
      if (ua.includes(osToken)) {
        return this._makeDeviceInfo(ORTB2_DEVICE_TYPE.PHONE, osName, ua);
      }
    }
    // Iterate over smarttvMapping
    for (const [osToken, osName] of this._smarttvMapping) {
      if (ua.includes(osToken)) {
        return this._makeDeviceInfo(ORTB2_DEVICE_TYPE.CONNECTED_TV, osName, ua);
      }
    }
    return { deviceType: "", osName: "", osVersion: "" };
  },

  _getDevicePixelRatioValue(win = (typeof window !== "undefined" ? window : undefined)) {
    if (!win) {
      return 1;
    }
    return (
      win.devicePixelRatio ||
      (win.screen.deviceXDPI / win.screen.logicalXDPI) ||
      Math.round(win.screen.availWidth / win.document.documentElement.clientWidth)
    );
  },

  _getScreenWidth(win = (typeof window !== "undefined" ? window : undefined)) {
    if (!win) {
      return 0;
    }
    return Math.round(win.screen.width * this._getDevicePixelRatioValue(win));
  },

  _getScreenHeight(win = (typeof window !== "undefined" ? window : undefined)) {
    if (!win) {
      return 0;
    }
    return Math.round(win.screen.height * this._getDevicePixelRatioValue(win));
  },

  _getMake(ua) {
    for (const [makeToken, brandName] of this._makeMapping) {
      if (ua.includes(makeToken)) {
        return brandName;
      }
    }
    return 'Generic';
  },

  _getModel(ua) {
    for (const [modelToken, modelName] of this._modelMapping) {
      if (ua.includes(modelToken)) {
        return modelName;
      }
    }
    return '';
  },

  // Public API - returns device object for First Party Data (global)
  FPD() {
    const useragent = typeof window !== "undefined" ? window.navigator.userAgent : "";
    const deviceInfo = this._getDeviceInfo(useragent);

    const win = typeof window !== "undefined" ? window : undefined;
    const pixelRatio = this._getDevicePixelRatioValue(win);
    const screenWidth = this._getScreenWidth(win);
    const screenHeight = this._getScreenHeight(win);

    const brand = this._getMake(useragent);
    const model = this._getModel(useragent);

    return {
      devicetype: deviceInfo.deviceType,
      make: brand,
      model: model,
      os: deviceInfo.osName,
      osv: deviceInfo.osVersion,
      hwv: model,
      h: screenHeight,
      w: screenWidth,
      pxratio: pixelRatio,
      js: 1
    };
  }
};
// ==================== END WURFL LCE DEVICE MODULE ====================
