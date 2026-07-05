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

  const RECURRING_FIXED_HOLIDAYS = [
    { md: '07-17', name: '제헌절', fromYear: 2026 }
  ];

  function addRecurringHolidays(holidays, endYear) {
    RECURRING_FIXED_HOLIDAYS.forEach(({ md, name, fromYear }) => {
      for (let y = fromYear; y <= endYear; y++) {
        const dateStr = `${y}-${md}`;
        holidays[dateStr] = name;
        const wd = weekdayOf(dateStr);
        if (wd === 0 || wd === 6) {
          let sub = new Date(y, Number(md.split('-')[0]) - 1, Number(md.split('-')[1]));
          do {
            sub.setDate(sub.getDate() + 1);
          } while (sub.getDay() === 0 || sub.getDay() === 6 || holidays[dateISO(sub.getFullYear(), sub.getMonth() + 1, sub.getDate())]);
          holidays[dateISO(sub.getFullYear(), sub.getMonth() + 1, sub.getDate())] = '대체공휴일';
        }
      }
    });
    return holidays;
  }

  addRecurringHolidays(KR_HOLIDAYS, 2035);

  function holidayName(dateStr) {
    return KR_HOLIDAYS[dateStr] || null;
  }

  function isRedDay(dateStr) {
    return weekdayOf(dateStr) === 0 || !!KR_HOLIDAYS[dateStr];
  }

  const CORNER_GROUPS = {
    '총괄': ['점장'],
    '관리': ['파트장'],
    '영업지원': ['카운터', '지원'],
    '문구': ['기프트', '학용', '필기구', '디자인문구', '사무', '전문', '문보장'],
    '서적': ['인문', '기술', '외국어', '아동', '소설', '경제']
  };

  const LEAVE_TYPES = {
    PERSONAL: '휴무',
    ANNUAL: '연차',
    CHEDAN: '체단',
    RECOGNIZED: '인정'
  };

  function createEmployee(id, name) {
    return { id, name, recurringOff: [], specificOff: [], specificOffTypes: {}, shiftPreference: 'ANY', corner: '', corners: [], edgeShiftPreference: false };
  }

  function leaveTypeOf(emp, dateStr) {
    return (emp.specificOffTypes && emp.specificOffTypes[dateStr]) || 'PERSONAL';
  }

  // 공휴일 근무 시 수당/대체휴일 선택은 실제로 그날 근무가 확정되기 전에도 미리 골라둘 수
  // 있도록 직원 정보(emp.holidayChoices)에 저장한다(사장님 지시: "본인이 빨간날에 근무할지
  // 안 할지는 아무도 모르니까 일단 설정은 모두에게 뜨게"). 이 기능이 생기기 전 예전 데이터는
  // schedule 셀의 holidayChoice에 남아 있을 수 있어 그것도 폴백으로 봐준다.
  function holidayChoiceOf(emp, empSchedule, dateStr) {
    if (emp.holidayChoices && emp.holidayChoices[dateStr] != null) return emp.holidayChoices[dateStr];
    const cell = empSchedule && empSchedule[dateStr];
    return (cell && cell.holidayChoice) || '';
  }

  function employeeCorners(emp) {
    if (emp.corners && emp.corners.length) return emp.corners;
    if (emp.corner) return [emp.corner];
    return [];
  }

  // Fairness grouping for red-day (weekend/holiday) rest rotation: 문보장 is large
  // enough (3 people) to rotate red-day rest on its own, but the other 문구 corners
  // (기프트/학용/필기구/디자인문구) are each too small individually, so they're pooled
  // together as one group. Same idea applies to 관리/서적 sub-corners.
  function cornerFairnessGroup(corner) {
    if (!corner) return null;
    if (corner === '문보장') return '문보장';
    for (const [groupName, corners] of Object.entries(CORNER_GROUPS)) {
      if (corners.includes(corner)) return groupName;
    }
    return corner;
  }

  // Which department (문구/서적) an employee's staffing counts toward. Returns null for
  // 관리 (점장/파트장/영업지원) — they don't belong to either department's own headcount.
  // An employee spanning corners from more than one department returns null too (ambiguous).
  function employeeDepartment(emp) {
    const corners = employeeCorners(emp);
    let found = null;
    for (const corner of corners) {
      for (const dept of ['문구', '서적']) {
        if (CORNER_GROUPS[dept].includes(corner)) {
          if (found && found !== dept) return null;
          found = dept;
        }
      }
    }
    return found;
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
      avoidAlternatingShift: false,
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
    cornerFairnessGroup,
    employeeDepartment,
    LEAVE_TYPES,
    leaveTypeOf,
    holidayChoiceOf,
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
