const jsonServer = require('json-server');
const server = jsonServer.create();
const router = jsonServer.router('db.json');
const middlewares = jsonServer.defaults();

server.use(middlewares);
server.use(jsonServer.bodyParser);
const db = () => router.db;

/**
 * Utility: Generate next UID
 */
function generateUid(db) {
  const year = new Date().getFullYear();
  const count = db.get('enquiries').size().value() + 1;
  return `ENQ_${year}_${String(count).padStart(4, '0')}`;
}

/**
 * GET /enquiries/next-uid
 */
server.get('/enquiries/next-uid', (req, res) => {
  const db = router.db;
  res.json({ uid: generateUid(db) });
});

/**
 * POST /enquiries
 * Validation + create enquiry
 */
server.post('/enquiries', (req, res) => {
  const data = req.body;
  const errors = {};

  // Required fields (match Drupal validation)
  const required = [
    'title_id',
    'name',
    'surname',
    'contact_number',
    'email',
    'country',
    'sector',
    'enquiry'
  ];

  required.forEach(field => {
    if (!data[field]) {
      errors[field] = `${field.replace('_', ' ')} is required`;
    }
  });

  // Email validation
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    errors.email = 'Please enter a valid email';
  }

  // Sector other
  if (data.sector === '4' && !data.sector_other) {
    errors.sector_other = 'Please specify sector';
  }

  // Enquiry length
  if (data.enquiry && data.enquiry.length > 10000) {
    errors.enquiry = 'Enquiry cannot be longer than 10000 characters';
  }

  if (Object.keys(errors).length) {
    return res.status(400).json({
      message: 'Validation failed',
      errors
    });
  }

  const db = router.db;
  const uid = generateUid(db);

  const enquiry = {
    id: Date.now(),
    uid,
    ...data,
    status: 'open',
    created_at: Math.floor(Date.now() / 1000)
  };

  db.get('enquiries').push(enquiry).write();

  res.status(201).json({ uid });
});

/**
 * GET /enquiries/:uid
 */
server.get('/enquiries/:uid', (req, res) => {
  const db = router.db;
  const enquiry = db
    .get('enquiries')
    .find({ uid: req.params.uid })
    .value();

  if (!enquiry) {
    return res.status(404).json({});
  }

  res.json(enquiry);
});

/**
 * GET /enquiries?email=
 */
server.get('/enquiries', (req, res) => {
  const db = router.db;

  if (req.query.email) {
    const list = db
      .get('enquiries')
      .filter({ email: req.query.email })
      .value();
    return res.json(list);
  }

  res.json(db.get('enquiries').value());
});

/**
 * POST /enquiries/:uid/files
 */
server.post('/enquiries/:uid/files', (req, res) => {
  const db = router.db;

  const file = {
    id: Date.now(),
    enquiry_uid: req.params.uid,
    filename: req.body.filename,
    filesize: req.body.filesize,
    mimetype: req.body.mimetype,
    description: req.body.description,
    created_at: Math.floor(Date.now() / 1000)
  };

  db.get('files').push(file).write();

  res.status(201).json({
    success: true,
    file_id: file.id
  });
});

/**
 * GET /enquiries/:uid/files
 */
server.get('/enquiries/:uid/files', (req, res) => {
  const db = router.db;

  const files = db
    .get('files')
    .filter({ enquiry_uid: req.params.uid })
    .value();

  res.json(files);
});
/**
 * GET /decisions/filters
 */
server.get('/decisions/filters', (req, res) => {
  res.json({
    sectors: db().get('sectors').value(),
    outcomes: db().get('outcomes').value(),
    reasons: db().get('not_upheld_reasons').value()
  });
});

/**
 * GET /decisions/issues
 */
server.get('/decisions/issues', (req, res) => {
  const sectorId = Number(req.query.sector_id);
  res.json(db().get('issues').filter({ sector_id: sectorId }).value());
});

/**
 * GET /decisions/products
 */
server.get('/decisions/products', (req, res) => {
  const sectorId = Number(req.query.sector_id);
  res.json(db().get('products').filter({ sector_id: sectorId }).value());
});

/**
 * GET /decisions
 */
server.get('/decisions', (req, res) => {
  const {
    page = 1,
    limit = 20,
    year,
    outcome,
    sector,
    issue,
    product,
    provider,
    language,
    case_reference
  } = req.query;

  let decisions = db().get('decisions').filter({ published: 1 }).value();

  if (year) {
    decisions = decisions.filter(d =>
      new Date(d.year_of_decision * 1000).getFullYear() == year
    );
  }

  if (outcome) decisions = decisions.filter(d => d.outcome_id == outcome);
  if (sector) decisions = decisions.filter(d => d.sector_id == sector);
  if (issue) decisions = decisions.filter(d => d.issue_id == issue);
  if (product) decisions = decisions.filter(d => d.product_id == product);
  if (language) decisions = decisions.filter(d => d.language === language);
  if (case_reference)
    decisions = decisions.filter(d =>
      d.case_reference_number.includes(case_reference)
    );

  if (provider) {
    decisions = decisions.filter(d => d.provider_ids.includes(Number(provider)));
  }

  const total = decisions.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const offset = (page - 1) * limit;
  decisions = decisions.slice(offset, offset + Number(limit));

  const providersLoad = {};
  const years = {};
  const result = {};

  decisions.forEach(d => {
    const closure = db().get('complaint_classification')
      .find({ complaint_id: d.complaint_id })
      .value();

    const decisionDate = closure?.closure_date || d.year_of_decision;
    years[new Date(decisionDate * 1000).getFullYear()] = true;

    const sectorObj = db().get('sectors').find({ id: d.sector_id }).value();
    const issueObj = db().get('issues').find({ id: d.issue_id }).value();
    const productObj = db().get('products').find({ id: d.product_id }).value();
    const outcomeObj = db().get('outcomes').find({ id: d.outcome_id }).value();

    const providerData = {};
    const providerNames = [];

    d.provider_ids.forEach(pid => {
      const p = db().get('providers').find({ id: pid }).value();
      if (p) {
        providersLoad[pid] = p;
        providerNames.push(p.name);
        providerData[pid] = {
          decision_provider_id: db()
            .get('decision_providers')
            .find({ decision_id: d.decision_id, provider_id: pid })
            ?.value()?.decision_provider_id,
          provider_id: pid,
          service_provider: p.name
        };
      }
    });

    result[d.decision_id] = {
      decision_id: d.decision_id,
      case_reference_number: d.case_reference_number,
      file_path: d.file_path,
      file_id: d.file_id,
      language: d.language,
      complainant: d.complainant,
      sector_id: d.sector_id,
      sector: sectorObj?.name,
      complaint_category_issue_id: d.issue_id,
      complaint_category_issue: issueObj?.name,
      complaint_category_issue_code: issueObj?.code,
      complaint_category_product_id: d.product_id,
      complaint_category_product: productObj?.name,
      complaint_category_product_code: productObj?.code,
      year_of_decision: decisionDate,
      year_of_decision_formatted: new Date(decisionDate * 1000).toLocaleDateString('en-GB'),
      outcome_id: d.outcome_id,
      outcome: outcomeObj?.name,
      not_upheld_reason_id: d.not_upheld_reason_id,
      published_date: d.published_date,
      published_date_formatted: new Date(d.published_date * 1000).toLocaleDateString('en-GB'),
      published: d.published,
      court_appeal: d.court_appeal ? 'Appealed' : 'Not Appealed',
      providers: providerData,
      provider_names: providerNames.join(',<br/>'),
      provider_ids: d.provider_ids
    };
  });

  res.json({
    page: Number(page),
    pages,
    filters: {
      years,
      providers_load: providersLoad
    },
    decisions: result
  });
});

/**
 * GET /directors
 * Fetch directors with optional filtering (e.g., ?complaint_id=123)
 */
server.get('/directors', (req, res) => {
  const db = router.db;
  const { complaint_id } = req.query;

  let directors = db.get('directors').value();

  // If a complaint_id is provided, filter the results
  if (complaint_id) {
    directors = db.get('directors')
      .filter({ complaint_id: Number(complaint_id) })
      .value();
  }

  res.json(directors);
});

/**
 * GET /directors/:id
 * Fetch a single director by their unique ID
 */
server.get('/directors/:id', (req, res) => {
  const db = router.db;
  const director = db
    .get('directors')
    .find({ id: Number(req.params.id) })
    .value();

  if (!director) {
    return res.status(404).json({ message: "Director not found" });
  }

  res.json(director);
});

/**
 * POST /directors
 * Adds a director to a specific complaint (replaces oafs_cms_complaint_add_director)
 */
server.post('/directors', (req, res) => {
  const data = req.body;
  const errors = {};

  // 1. Validate (Mirroring oafs_cms_validate_complaint_director)
  if (!data.complaint_id) {
    errors.session = 'Complaint ID is missing from session/request';
  }
  if (!data.first_name) errors.first_name = 'First name is required';
  if (!data.last_name) errors.last_name = 'Last name is required';

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  // 2. Logic to Save
  const db = router.db;
  const newDirector = {
    id: Date.now(),
    complaint_id: data.complaint_id,
    first_name: data.first_name,
    last_name: data.last_name,
    email: data.email || '',
    role: data.role || 'Director',
    created_at: Math.floor(Date.now() / 1000)
  };

  db.get('directors').push(newDirector).write();

  // Return success (Mirroring the Drupal redirect logic)
  res.status(201).json({ 
    success: true, 
    director_id: newDirector.id,
    redirect_section: 5 
  });
});

/**
 * DELETE /directors/:id
 * Removes a director from the complaint
 */
server.delete('/directors/:id', (req, res) => {
  const { id } = req.params;
  const db = router.db;

  const exists = db.get('directors').find({ id: Number(id) }).value();

  if (!exists) {
    return res.status(404).json({ success: false, message: 'Director not found' });
  }

  db.get('directors').remove({ id: Number(id) }).write();
  
  res.json({ success: true, message: 'Director removed' });
});

/**
 * Utility: Generate Reference (oafs_cms_complaint_generate_reference)
 */
function generateComplaintRef(db) {
    const year = new Date().getFullYear();
    const count = db.get('complaints').size().value() + 1;
    return `ASF ${String(count).padStart(3, '0')}/${year}`;
}

/**
 * Step 1: Initialize Complaint (oafs_cms_create_complaint)
 */
server.post('/complaints/init', (req, res) => {
    const { user_id, complainant_type_id, language = 'en' } = req.body;

    if (!complainant_type_id) {
        return res.status(400).json({ errors: { complainant_type_id: "Type is required" } });
    }

    const newComplaint = {
        id: Date.now(),
        user_id: Number(user_id) || 0,
        status_id: 1, // Draft
        complainant_type_id: Number(complainant_type_id),
        complaint_section: 1,
        language,
        date_created: Math.floor(Date.now() / 1000),
        date_updated: Math.floor(Date.now() / 1000),
        // Sections initialized as empty objects to mimic Drupal tables
        individual: {},
        company: { directors: [] },
        assistant: {},
        service_provider: { provider_ids: [], product_name: "", reference: "" },
        details: { additional_files: [] }
    };

    db().get('complaints').push(newComplaint).write();
    res.status(201).json(newComplaint);
});

/**
 * Step 2-4: Update Sections (Autosave/Manual Save)
 * Handles Section 2 (Individual), 5 (Company), 6 (Assistant), etc.
 */
server.patch('/complaints/:id/section/:section', (req, res) => {
    const sectionId = Number(req.params.section);
    const complaintId = Number(req.params.id);
    const complaint = db().get('complaints').find({ id: complaintId }).value();

    if (!complaint) return res.status(404).json({ message: "Complaint not found" });

    let updateData = {};
    // Map URL sections to internal object keys
    const sectionMap = { 2: 'individual', 5: 'company', 6: 'assistant', 7: 'service_provider', 8: 'details' };
    const key = sectionMap[sectionId];

    if (key) {
        updateData[key] = { ...complaint[key], ...req.body };
        // Update progress section if it's further than current
        updateData.complaint_section = Math.max(complaint.complaint_section, sectionId);
        updateData.date_updated = Math.floor(Date.now() / 1000);

        db().get('complaints').find({ id: complaintId }).assign(updateData).write();
        res.json(db().get('complaints').find({ id: complaintId }).value());
    } else {
        res.status(400).json({ message: "Invalid section" });
    }
});

/**
 * Final Submission (oafs_cms_complaint_submit Section 9)
 */
server.post('/complaints/:id/submit', (req, res) => {
    const complaintId = Number(req.params.id);
    const complaint = db().get('complaints').find({ id: complaintId }).value();

    if (!complaint) return res.status(404).json({ message: "Not found" });

    const reference = generateComplaintRef(db());
    
    db().get('complaints')
        .find({ id: complaintId })
        .assign({ 
            status_id: 2, // Submitted
            complaint_uid: reference,
            date_originated: Math.floor(Date.now() / 1000)
        })
        .write();

    res.json({ success: true, reference });
});

/**
 * Fetch Complaints for a specific User (My Complaints)
 */
server.get('/users/:uid/complaints', (req, res) => {
    const results = db().get('complaints')
        .filter({ user_id: Number(req.params.uid) })
        .value();
    res.json(results);
});

server.use(router);

server.listen(3001, () => {
  console.log('OAFS Mock API running at http://localhost:3001');
});
