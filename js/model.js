window.Hyumu = window.Hyumu || {};

Hyumu.Model = (function () {
  const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function daysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
  }

  function dateISO(year, month, day) {
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  function weekdayOf(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).getDay();
  }

  function isWeekend(dateStr) {
    const wd = weekdayOf(dateStr);
    return wd === 0 || wd === 6;
  }

  function allDatesOfMonth(year, month) {
    const n = daysInMonth(year, month);
    const arr = [];
    for (let d = 1; d <= n; d++) arr.push(dateISO(year, month, d));
    return arr;
  }

  function monthKey(year, month) {
    return `${year}-${pad2(month)}`;
  }

  const KR_HOLIDAYS = {
    '2025-01-01': '신정',
    '2025-01-28': '설날 연휴',
    '2025-01-29': '설날',
    '2025-01-30': '설날 연휴',
    '2025-03-01': '삼일절',
    '2025-03-03': '대체공휴일',
    '2025-05-05': '어린이날',
    '2025-05-06': '대체공휴일',
    '2025-06-06': '현충일',
    '2025-08-15': '광복절',
    '2025-10-03': '개천절',
    '2025-10-05': '추석 연휴',
    '2025-10-06': '추석',
    '2025-10-07': '추석 연휴',
    '2025-10-08': '대체공휴일',
    '2025-10-09': '한글날',
    '2025-12-25': '성탄절',
    '2026-01-01': '신정',
    '2026-02-16': '설날 연휴',
    '2026-02-17': '설날',
    '2026-02-18': '설날 연휴',
    '2026-03-01': '삼일절',
    '2026-03-02': '대체공휴일',
    '2026-05-05': '어린이날',
    '2026-05-24': '부처님오신날',
    '2026-05-25': '대체공휴일',
    '2026-06-06': '현충일',
    '2026-08-15': '광복절',
    '2026-08-17': '대체공휴일',
    '2026-09-24': '추석 연휴',
    '2026-09-25': '추석',
    '2026-09-26': '추석 연휴',
    '2026-10-03': '개천절',
    '2026-10-05': '대체공휴일',
    '2026-10-09': '한글날',
    '2026-12-25': '성탄절',
    '2027-01-01': '신정'
  };

  function holidayName(dateStr) {
    return KR_HOLIDAYS[dateStr] || null;
  }

  function isRedDay(dateStr) {
    return weekdayOf(dateStr) === 0 || !!KR_HOLIDAYS[dateStr];
  }

  const CORNER_GROUPS = {
    '관리': ['점장', '파트장', '영업지원'],
    '문구': ['기프트', '학용', '필기구', '문보장'],
    '서적': ['인문', '기술', '외국어', '아동', '소설', '경제']
  };

  function createEmployee(id, name) {
    return { id, name, recurringOff: [], specificOff: [], shiftPreference: 'ANY', corner: '', corners: [] };
  }

  function employeeCorners(emp) {
    if (emp.corners && emp.corners.length) return emp.corners;
    if (emp.corner) return [emp.corner];
    return [];
  }

  function defaultRules() {
    return {
      minStaffDefault: 1,
      minStaffByWeekday: {},
      minStaffByDate: {},
      maxConsecutiveWorkDays: 5,
      minRestPerWeekWindow: false,
      minMorningStaff: 0,
      minAfternoonStaff: 0,
      minStaffByCorner: {},
      dateLabels: {}
    };
  }

  const SHIFT_LABELS = { MORNING: '오전', AFTERNOON: '오후' };

  function createMonthDoc(year, month) {
    return {
      version: 1,
      month: { year, month },
      employees: [],
      rules: defaultRules(),
      schedule: {},
      conflicts: [],
      meta: { nextEmployeeId: 1 }
    };
  }

  function isBaseOff(employee, dateStr) {
    if (employee.specificOff.includes(dateStr)) return true;
    return employee.recurringOff.includes(weekdayOf(dateStr));
  }

  function minStaffRequired(rules, dateStr) {
    if (rules.minStaffByDate && rules.minStaffByDate[dateStr] != null) {
      return rules.minStaffByDate[dateStr];
    }
    const wd = weekdayOf(dateStr);
    if (rules.minStaffByWeekday && rules.minStaffByWeekday[wd] != null) {
      return rules.minStaffByWeekday[wd];
    }
    return rules.minStaffDefault;
  }

  return {
    WEEKDAY_LABELS,
    SHIFT_LABELS,
    CORNER_GROUPS,
    KR_HOLIDAYS,
    holidayName,
    isRedDay,
    employeeCorners,
    pad2,
    daysInMonth,
    dateISO,
    weekdayOf,
    isWeekend,
    allDatesOfMonth,
    monthKey,
    createEmployee,
    defaultRules,
    createMonthDoc,
    isBaseOff,
    minStaffRequired
  };
})();
