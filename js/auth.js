window.Hyumu = window.Hyumu || {};

Hyumu.Auth = (function () {
  const SESSION_ID_KEY = 'hyumu.session.employeeId';
  const SESSION_STORE_KEY = 'hyumu.session.store';
  let db = null;

  const STORE_LIST = [
    '광화문점', '가든파이브점', '강남점', '건대스타시티점', '동대문점', '목동점',
    '서울대점', '수유점', '영등포점', '원그로브점', '은평점', '이화여대점',
    '잠실점', '천호점', '청량리점', '합정점', '광교점', '분당점', '송도점',
    '인천점', '일산점', '판교점', '평촌점', '수원점', '경성대ㆍ부경대점',
    '광주상무점', '대구점', '대전점', '부산점', '세종점', '센텀시티점',
    '울산점', '전주점', '창원점', '천안점', '칠곡점'
  ].sort((a, b) => a.localeCompare(b, 'ko'));

  function getDb() {
    if (!db) {
      db = firebase.apps.length ? firebase.app().firestore() : firebase.initializeApp(window.HYUMU_FIREBASE_CONFIG).firestore();
    }
    return db;
  }

  async function hash(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function signup(employeeId, password, phone, store) {
    const id = employeeId.trim();
    if (!id || !password || !phone || !store) {
      throw new Error('점포, 사번, 비밀번호, 휴대폰번호를 모두 입력하세요.');
    }
    const ref = getDb().collection('users').doc(id);
    const existing = await ref.get();
    if (existing.exists) {
      throw new Error('이미 가입된 사번입니다.');
    }
    const passwordHash = await hash(password);
    await ref.set({ employeeId: id, phone, store, passwordHash, createdAt: Date.now() });
    setSession(id, store);
    return { employeeId: id, store };
  }

  async function login(employeeId, password) {
    const id = employeeId.trim();
    const ref = getDb().collection('users').doc(id);
    const doc = await ref.get();
    if (!doc.exists) {
      throw new Error('사번 또는 비밀번호가 올바르지 않습니다.');
    }
    const data = doc.data();
    const passwordHash = await hash(password);
    if (data.passwordHash !== passwordHash) {
      throw new Error('사번 또는 비밀번호가 올바르지 않습니다.');
    }
    setSession(id, data.store);
    return { employeeId: id, store: data.store };
  }

  function setSession(employeeId, store) {
    localStorage.setItem(SESSION_ID_KEY, employeeId);
    localStorage.setItem(SESSION_STORE_KEY, store || '');
  }

  function getCurrentUser() {
    const employeeId = localStorage.getItem(SESSION_ID_KEY);
    if (!employeeId) return null;
    return { employeeId, store: localStorage.getItem(SESSION_STORE_KEY) || '' };
  }

  function logout() {
    localStorage.removeItem(SESSION_ID_KEY);
    localStorage.removeItem(SESSION_STORE_KEY);
  }

  return { signup, login, logout, getCurrentUser, STORE_LIST };
})();
